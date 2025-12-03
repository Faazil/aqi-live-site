const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// Render port
const PORT = process.env.PORT || 3000;

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API Route - Using OpenAQ (Free, No Key Needed)
app.get('/api/aqi', async (req, res) => {
  try {
    const city = req.query.city || "Delhi";
    
    const url = "https://api.openaq.org/v3/latest";
    const response = await axios.get(url, {
      params: { city, limit: 100 }
    });

    const results = response.data.results || [];
    if (!results.length) {
      return res.json({
        city,
        measurements: [],
        computedAQI: null
      });
    }

    const measurements = results[0].measurements.map(m => ({
      parameter: m.parameter,
      value: m.value,
      unit: m.unit,
      lastUpdated: m.lastUpdated
    }));

    // Simple AQI Estimate (fallback)
    const pm25 = measurements.find(m => m.parameter === "pm25");
    let computedAQI = null;
    if (pm25) {
      const v = pm25.value;
      computedAQI = Math.round(v * 4); // simple scaling
    }

    return res.json({ city, measurements, computedAQI });
  } catch (err) {
    console.error("API Error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Upstream API error" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
