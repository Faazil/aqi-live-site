// backend/server.js
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const OPENAQ_KEY = (process.env.OPENAQ_API_KEY || '').trim();
const WAQI_TOKEN = (process.env.WAQI_TOKEN || '').trim();
const CACHE_TTL_MS = 60 * 1000;

// Aggregator configuration (env override)
const AGG_POLL_INTERVAL_MS = Number(process.env.AGG_POLL_INTERVAL_MS) || (5 * 60 * 1000); // 5 minutes
const AGG_KEEP_MS = Number(process.env.AGG_KEEP_MS) || (24 * 60 * 60 * 1000); // 24 hours
const AGG_CITIES = (process.env.AGG_CITIES && process.env.AGG_CITIES.split(',').map(s => s.trim()).filter(Boolean)) || [
  'Delhi','Mumbai','Bengaluru','Kolkata','Chennai','Hyderabad','Pune','Ahmedabad',
  'Lucknow','Jaipur','Kanpur','Nagpur','Indore','Bhopal','Patna','Surat',
  'Vadodara','Visakhapatnam','Coimbatore','Ludhiana','Agra','Nashik','Faridabad',
  'Meerut','Rajkot','Kochi','Varanasi','Srinagar','Amritsar','Guwahati'
];

const cache = new Map(); // original short-lived cache for direct fetches

app.use(express.static(path.join(__dirname, 'public')));

// ------------------ existing helpers & fetch functions ------------------
function computeSimpleAQI(measurements) {
  // fallback approx based on pm2.5 or pm10
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
  // first attempt feed endpoint
  try {
    const first = await fetchWAQIbyFeed(city);
    const hasPM = first.measurements.some(m => m.parameter === 'pm25' || m.parameter === 'pm10');
    if (hasPM) return first;
    // fallback: search for station uid
  } catch (err) {
    // continue to search fallback
  }

  // Search endpoint to find best station
  const s = await axios.get('https://api.waqi.info/search/', {
    params: { token: WAQI_TOKEN, keyword: city }, timeout: 10000
  });
  if (!s.data || !Array.isArray(s.data.data) || s.data.data.length === 0) {
    throw new Error('WAQI search returned no stations');
  }
  const uid = s.data.data[0].uid;
  if (!uid) throw new Error('No WAQI uid found');
  // call feed by uid
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

// ------------------ Aggregator (in-memory) ------------------
// store structure: Map city -> { latest: {city, measurements, computedAQI, t}, history: [ {t, computedAQI, measurements} ] }
const aggregatorStore = new Map();

function pushAggregatorSample(city, sample) {
  const now = Date.now();
  if (!aggregatorStore.has(city)) aggregatorStore.set(city, { latest: null, history: [] });
  const entry = aggregatorStore.get(city);
  entry.latest = { ...sample, t: now };
  entry.history.push({ t: now, computedAQI: sample.computedAQI ?? null, measurements: sample.measurements ?? [] });
  // prune history older than AGG_KEEP_MS
  const cutoff = Date.now() - AGG_KEEP_MS;
  entry.history = entry.history.filter(p => p.t >= cutoff);
}

function getAggregatorLatest(city) {
  const e = aggregatorStore.get(city);
  return e ? e.latest : null;
}

function getAggregatorHistory(city) {
  const e = aggregatorStore.get(city);
  return e ? (e.history || []) : [];
}

function getAllAggregatorLatest() {
  const out = {};
  for (const c of AGG_CITIES) {
    out[c] = getAggregatorLatest(c);
  }
  return out;
}

async function aggregatorFetchCity(city) {
  // Prefer OpenAQ if configured, then WAQI fallback
  try {
    if (OPENAQ_KEY) {
      try {
        const data = await fetchOpenAQv3(city);
        return data;
      } catch (err) {
        console.warn(`[aggregator] OpenAQ failed for ${city}:`, err.message || err);
      }
    }
    if (WAQI_TOKEN) {
      try {
        const data = await fetchWAQISearchThenFeed(city);
        return data;
      } catch (err) {
        console.warn(`[aggregator] WAQI failed for ${city}:`, err.message || err);
      }
    }
    // no provider configured
    return { city, measurements: [], computedAQI: null, error: 'no-provider' };
  } catch (err) {
    return { city, measurements: [], computedAQI: null, error: String(err) };
  }
}

let aggRunning = false;
async function aggregatorPollAll(concurrency = 6) {
  if (aggRunning) return;
  aggRunning = true;
  try {
    console.info('[aggregator] poll start for', AGG_CITIES.length, 'cities');
    const results = [];
    let idx = 0;
    const workers = new Array(Math.min(concurrency, AGG_CITIES.length)).fill().map(async () => {
      while (idx < AGG_CITIES.length) {
        const i = idx++;
        const city = AGG_CITIES[i];
        try {
          const r = await aggregatorFetchCity(city);
          results.push(r);
          if (!r.error) pushAggregatorSample(city, r);
          else console.warn('[aggregator] city error', city, r.error || '');
        } catch (e) {
          console.error('[aggregator] fetch exception for', city, e);
        }
      }
    });
    await Promise.all(workers);
    console.info('[aggregator] poll finished, samples:', results.length);
  } finally {
    aggRunning = false;
  }
}

// start aggregator polling
setImmediate(() => {
  // run initial poll immediately then schedule
  aggregatorPollAll().catch(e => console.error('[aggregator] initial poll error', e));
  setInterval(() => {
    aggregatorPollAll().catch(e => console.error('[aggregator] periodic poll error', e));
  }, AGG_POLL_INTERVAL_MS);
});

// ------------------ API endpoints ------------------

// Aggregator endpoint: latest + history
app.get('/api/aqi/aggregate', (req, res) => {
  try {
    const payload = {
      ts: Date.now(),
      cities: getAllAggregatorLatest()
    };
    return res.json(payload);
  } catch (err) {
    console.error('[api/aqi/aggregate] err', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// Main /api/aqi endpoint: prefer aggregator cached latest if available (fast)
app.get('/api/aqi', async (req, res, next) => {
  const city = (req.query.city || 'Delhi').trim();
  // if aggregator has cached latest, return it
  const cachedAgg = getAggregatorLatest(city);
  if (cachedAgg) {
    return res.json(cachedAgg);
  }
  // else try the short-lived cache used originally
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
      // fallthrough to WAQI
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

// fallback serving index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
