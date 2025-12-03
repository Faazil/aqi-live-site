// backend/server.js
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// Port (Render sets PORT automatically)
const PORT = process.env.PORT || 3000;

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

/**
 * computeSimpleAQI
 * A fallback / display-only not-official AQI estimate based on PM2.5.
 * For production use official EPA/CPCB conversions.
 */
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

// API endpoint: /api/aqi?city=Delhi
app.get('/api/aqi', async (req, res) => {
  try {
    const city = (req.query.city || 'Delhi').trim();
    const url = 'https://api.openaq.org/v3/latest';

    const r = await axios.get(url, {
      params: { city, limit: 100 },
      timeout: 10000
    });

    const results = r.data && r.data.results ? r.data.results : [];
    if (!results.length) {
      return res.json({ city, measurements: [], computedAQI: null });
    }

    // Merge measurements from the first result (most relevant)
    const measurements = (results[0].measurements || []).map(m => ({
      parameter: m.parameter, value: m.value, unit: m.unit, lastUpdated: m.lastUpdated
    }));

    const computedAQI = computeSimpleAQI(measurements);
    return res.json({ city, measurements, computedAQI });

  } catch (err) {
    // If upstream returns an error (rate limit, etc.) show a helpful message
    console.error('OpenAQ error:', err?.response?.data || err.message);
    // If upstream replied with no data, return empty array
    return res.status(500).json({ error: 'Upstream API error', details: err?.message || 'unknown' });
  }
});

// Fallback: serve index.html for client-side navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
