const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// Render sets the PORT automatically. Use 3000 as a default for local testing.
const PORT = process.env.PORT || 3000; 

// IMPORTANT: The API Key must be set in Render's environment variables.
// The default value here is only for local testing.
const AQI_API_KEY = process.env.AQI_API_KEY || 'c6bdbb62719f66f0526ef1209ef034f9288c5a44b27d1fa3e1a82171f56b3fdf'; 

// --- API Route to Fetch Data ---
app.get('/api/aqi', async (req, res) => {
    try {
        // Example: We are defaulting to 'delhi' for a consistent India-centric view.
        // You can change this or read it from a query parameter.
        const location = req.query.location || 'delhi'; 
        const AQI_API_URL = `https://api.waqi.info/feed/${location}/`;
        
        const response = await axios.get(AQI_API_URL, {
            params: {
                token: AQI_API_KEY
            }
        });
        
        // Check if data is valid before sending
        if (response.data && response.data.data) {
            return res.json(response.data.data);
        } else {
             return res.status(404).json({ error: 'AQI data not found for this location.' });
        }
    } catch (error) {
        console.error('Error fetching AQI data:', error.message);
        res.status(500).json({ error: 'Failed to fetch AQI data from provider.' });
    }
});

// --- Serve Static Frontend Files ---
// 1. Tell Express to look in the 'public' folder for files
app.use(express.static(path.join(__dirname, 'public')));

// 2. Catch-all route: For any URL not starting with /api, serve the main index.html file
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
