document.addEventListener('DOMContentLoaded', () => {
    // You can start with a default city, e.g., 'delhi' for India
    fetchAqiData('/api/aqi?location=delhi'); 
});

async function fetchAqiData(endpoint) {
    const aqiDisplay = document.getElementById('aqi-display');
    aqiDisplay.innerHTML = '<p>Fetching latest data...</p>';

    try {
        // The request goes to the Express server which handles the actual AQI API call
        const response = await fetch(endpoint);
        const data = await response.json();

        if (response.ok && data && data.aqi) {
            const aqiValue = data.aqi;
            const city = data.city.name || 'Unknown Location';
            
            // Function to determine status and color based on US EPA AQI brackets (widely used)
            const getStatus = (aqi) => {
                if (aqi <= 50) return { text: 'Good', class: 'good' };
                if (aqi <= 100) return { text: 'Moderate', class: 'moderate' };
                if (aqi <= 150) return { text: 'Unhealthy for Sensitive Groups', class: 'unhealthy-sensitive' };
                if (aqi <= 200) return { text: 'Unhealthy', class: 'unhealthy' };
                if (aqi <= 300) return { text: 'Very Unhealthy', class: 'very-unhealthy' };
                return { text: 'Hazardous', class: 'hazardous' };
            };
            
            const status = getStatus(aqiValue);

            aqiDisplay.innerHTML = `
                <h2>Current AQI for ${city}</h2>
                <div class="aqi-value ${status.class}">${aqiValue}</div>
                <p>Health Status: <strong>${status.text}</strong></p>
                <p class="time">Updated: ${new Date(data.time.iso).toLocaleString('en-IN')}</p>
                <p class="dominant-pollutant">Dominant Pollutant: <strong>${data.dominentpol || 'N/A'}</strong></p>
            `;
        } else {
            // Display friendly error if the server response is bad
            aqiDisplay.innerHTML = '<p class="error">AQI data unavailable for the selected city. Please check back later.</p>';
        }

    } catch (error) {
        console.error('Connection Error:', error);
        aqiDisplay.innerHTML = '<p class="error">Could not connect to the data server. Please check your internet connection.</p>';
    }
}
