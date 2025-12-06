// backend/server.js
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const OPENAQ_KEY = (process.env.OPENAQ_API_KEY || '').trim();
const WAQI_TOKEN = (process.env.WAQI_TOKEN || '').trim();
const CACHE_TTL_MS = 60 * 1000;

const cache = new Map();

app.use(express.static(path.join(__dirname, 'public')));

/* -------------------- helpers -------------------- */
function computeSimpleAQI(measurements) {
  const pm25 = measurements.find(m => m.parameter === 'pm25');
  const pm10 = measurements.find(m => m.parameter === 'pm10');
  const v = pm25 ? pm25.value : (pm10 ? pm10.value : null);
  if (v === null || v === undefined) return null;
  if (v <= 12) return Math.round(25 * v / 12);
  if (v <= 35.4) return Math.round(50 + (50 * (v - 12) / (35.4 - 12)));
  if (v <= 55.4) return Math.round(100 + (100 * (v - 35.4) / (55.4 - 35.4)));
  return Math.round(200 + (200 * (v - 55.4) / 100));
}

async function fetchOpenAQv3(city) {
  const url = 'https://api.openaq.org/v3/latest';
  const headers = OPENAQ_KEY ? { 'X-API-Key': OPENAQ_KEY } : {};
  const r = await axios.get(url, { params: { city, limit: 100 }, headers, timeout: 10000 });
  const results = r.data && r.data.results ? r.data.results : [];
  if (!results.length) return { city, measurements: [], computedAQI: null };
  const measurements = (results[0].measurements || []).map(m => ({
    parameter: m.parameter, value: m.value, unit: m.unit, lastUpdated: m.lastUpdated
  }));
  return { city, measurements, computedAQI: computeSimpleAQI(measurements) };
}

async function fetchWAQIbyFeed(city) {
  const url = `https://api.waqi.info/feed/${encodeURIComponent(city)}/`;
  const r = await axios.get(url, { params: { token: WAQI_TOKEN }, timeout: 10000 });
  if (!r.data) throw new Error('No WAQI response');
  if (r.data.status !== 'ok') {
    const msg = r.data.data || JSON.stringify(r.data);
    const e = new Error('WAQI feed error: ' + msg);
    e._waqi = true;
    throw e;
  }
  const iaqi = r.data.data.iaqi || {};
  const measurements = Object.keys(iaqi).map(k => ({
    parameter: k,
    value: iaqi[k].v,
    unit: iaqi[k].u || '',
    lastUpdated: r.data.data.time ? r.data.data.time.s : null
  }));
  return { city, measurements, computedAQI: computeSimpleAQI(measurements) };
}

async function fetchWAQISearchThenFeed(city) {
  try {
    const first = await fetchWAQIbyFeed(city);
    const hasPM = Array.isArray(first.measurements) && first.measurements.some(m => m.parameter === 'pm25' || m.parameter === 'pm10');
    if (hasPM) return first;
  } catch (err) {
    // continue to search fallback
  }

  const s = await axios.get('https://api.waqi.info/search/', {
    params: { token: WAQI_TOKEN, keyword: city }, timeout: 10000
  });
  if (!s.data || !Array.isArray(s.data.data) || s.data.data.length === 0) {
    throw new Error('WAQI search returned no stations');
  }
  const uid = s.data.data[0].uid;
  if (!uid) throw new Error('No WAQI uid found');
  const r = await axios.get(`https://api.waqi.info/feed/@${uid}/`, { params: { token: WAQI_TOKEN }, timeout: 10000 });
  if (!r.data || r.data.status !== 'ok') throw new Error('WAQI feed by uid failed: ' + JSON.stringify(r.data));
  const iaqi = r.data.data.iaqi || {};
  const measurements = Object.keys(iaqi).map(k => ({
    parameter: k,
    value: iaqi[k].v,
    unit: iaqi[k].u || '',
    lastUpdated: r.data.data.time ? r.data.data.time.s : null
  }));
  return { city, measurements, computedAQI: computeSimpleAQI(measurements) };
}

/* -------------------- single-city endpoint -------------------- */
app.get('/api/aqi', async (req, res) => {
  const city = (req.query.city || 'Delhi').trim();
  const cacheKey = `aqi:${city.toLowerCase()}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return res.json(cached.data);

  // Try OpenAQ v3 first if key exists
  if (OPENAQ_KEY) {
    try {
      const data = await fetchOpenAQv3(city);
      cache.set(cacheKey, { ts: now, data });
      return res.json(data);
    } catch (err) {
      const masked = OPENAQ_KEY ? (OPENAQ_KEY.slice(0,6) + '***' + OPENAQ_KEY.slice(-4)) : '(none)';
      console.error('OpenAQ v3 failed (key='+masked+') -', err.response ? (err.response.status + ' ' + JSON.stringify(err.response.data)) : err.message);
    }
  }

  // Then try WAQI (feed with fallback to search→feed)
  if (WAQI_TOKEN) {
    try {
      const data = await fetchWAQISearchThenFeed(city);
      cache.set(cacheKey, { ts: now, data });
      return res.json(data);
    } catch (err) {
      console.error('WAQI fetch failed -', err.message || err);
    }
  }

  return res.status(503).json({
    error: 'No upstream provider returned data',
    details: 'Set a valid OPENAQ_API_KEY or WAQI_TOKEN in environment variables.'
  });
});

/* -------------------- aggregate snapshot endpoint -------------------- */
const AGG_CITIES = [
  'Delhi','Mumbai','Bengaluru','Kolkata','Chennai','Hyderabad','Pune','Ahmedabad',
  'Lucknow','Jaipur','Kanpur','Nagpur','Indore','Bhopal','Patna','Surat',
  'Vadodara','Visakhapatnam','Coimbatore','Ludhiana','Agra','Nashik','Faridabad',
  'Meerut','Rajkot','Kochi','Varanasi','Srinagar','Amritsar','Guwahati'
];
const AGG_CACHE_KEY = 'aqi:aggregate';
const AGG_TTL_MS = 2 * 60 * 1000; // cache 2 minutes

async function fetchBestForCity(city){
  try {
    if (OPENAQ_KEY){
      const d = await fetchOpenAQv3(city);
      if (d && d.measurements && d.measurements.length) return d;
    }
  } catch(e){ /* ignore */ }
  if (WAQI_TOKEN){
    try {
      const d = await fetchWAQISearchThenFeed(city);
      if (d) return d;
    } catch(e){ /* ignore */ }
  }
  return { city, measurements: [], computedAQI: null };
}

app.get('/api/aqi/aggregate', async (req, res) => {
  try {
    const now = Date.now();
    const cachedAgg = cache.get(AGG_CACHE_KEY);
    if (cachedAgg && (now - cachedAgg.ts) < AGG_TTL_MS) return res.json(cachedAgg.data);

    const concurrency = 6;
    let i = 0;
    const results = {};
    const workers = new Array(concurrency).fill(0).map(async () => {
      while (i < AGG_CITIES.length) {
        const idx = i++;
        const city = AGG_CITIES[idx];
        try {
          const r = await fetchBestForCity(city);
          results[city] = r;
        } catch (e) {
          results[city] = { city, error: e.message || 'fetch_failed' };
        }
      }
    });
    await Promise.all(workers);

    const payload = { cities: results };
    cache.set(AGG_CACHE_KEY, { ts: now, data: payload });
    return res.json(payload);
  } catch (err) {
    console.error('aggregate failed', err);
    return res.status(500).json({ error: 'aggregate_failed' });
  }
});

/* fallback serving index.html */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
