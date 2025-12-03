// backend/server.js
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const OPENAQ_KEY = (process.env.OPENAQ_API_KEY || '').trim(); // for OpenAQ v3
const WAQI_TOKEN = (process.env.WAQI_TOKEN || '').trim();     // for WAQI api.waqi.info
const CACHE_TTL_MS = 60 * 1000; // cache 60s

// Simple in-memory cache
const cache = new Map();

app.use(express.static(path.join(__dirname, 'public')));

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
  // Normalize to measurements array like [{parameter,value,unit,lastUpdated}, ...]
  const results = r.data && r.data.results ? r.data.results : [];
  if (!results.length) return { city, measurements: [], computedAQI: null };
  const measurements = (results[0].measurements || []).map(m => ({
    parameter: m.parameter, value: m.value, unit: m.unit, lastUpdated: m.lastUpdated
  }));
  return { city, measurements, computedAQI: computeSimpleAQI(measurements) };
}

async function fetchWAQI(city) {
  const url = `https://api.waqi.info/feed/${encodeURIComponent(city)}/`;
  const r = await axios.get(url, { params: { token: WAQI_TOKEN }, timeout: 10000 });
  if (!r.data) throw new Error('No response from WAQI');
  if (r.data.status !== 'ok') {
    // WAQI returns status:'error' with message in r.data.data
    const msg = r.data.data || JSON.stringify(r.data);
    const e = new Error('WAQI error: ' + msg);
    e._waqi = true;
    throw e;
  }
  // Convert WAQI iaqi to our measurements format
  const iaqi = r.data.data.iaqi || {};
  const measurements = Object.keys(iaqi).map(k => ({
    parameter: k,
    value: iaqi[k].v,
    unit: iaqi[k].u || '',
    lastUpdated: r.data.data.time ? r.data.data.time.s : null
  }));
  return { city, measurements, computedAQI: computeSimpleAQI(measurements) };
}

app.get('/api/aqi', async (req, res) => {
  const city = (req.query.city || 'Delhi').trim();
  const cacheKey = `aqi:${city.toLowerCase()}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  // Try OpenAQ v3 if key is present (preferred)
  if (OPENAQ_KEY) {
    try {
      const data = await fetchOpenAQv3(city);
      cache.set(cacheKey, { ts: now, data });
      return res.json(data);
    } catch (err) {
      // Log masked key and upstream details
      const masked = OPENAQ_KEY ? (OPENAQ_KEY.slice(0,6) + '***' + OPENAQ_KEY.slice(-4)) : '(none)';
      console.error('OpenAQ v3 attempt failed (key='+masked+'):',
        err.response ? (err.response.status + ' ' + JSON.stringify(err.response.data)) : err.message);
      // fallthrough to WAQI if configured
    }
  }

  // If WAQI token is present, try WAQI
  if (WAQI_TOKEN) {
    try {
      const data = await fetchWAQI(city);
      cache.set(cacheKey, { ts: now, data });
      return res.json(data);
    } catch (err) {
      console.error('WAQI attempt failed:', err.message || err);
      // final fallthrough
    }
  }

  // If we reach here, neither provider returned usable data
  const msg = {
    error: 'No upstream provider returned data',
    details: 'Configure a valid OPENAQ_API_KEY (for OpenAQ v3) or WAQI_TOKEN (for WAQI).'
  };
  return res.status(503).json(msg);
});

// serve index.html for routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
