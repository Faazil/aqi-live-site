// backend/public/script.js (updated)
const cityInput = document.getElementById('city');
const fetchBtn = document.getElementById('fetchBtn');
const statusDiv = document.getElementById('status');
const cityName = document.getElementById('city-name');
const aqiValue = document.getElementById('aqi-value');
const aqiDesc = document.getElementById('aqi-desc');
const canvas = document.getElementById('aqiChart');
const ctx = canvas ? canvas.getContext('2d') : null;
let chart = null;

// helpers
function setStatus(text) {
  if (statusDiv) statusDiv.textContent = text;
  console.log('[UI] status:', text);
}

function aqiColor(aqi) {
  if (aqi === null || aqi === undefined) return '#6b7280';
  if (aqi <= 50) return '#16a34a';
  if (aqi <= 100) return '#f59e0b';
  if (aqi <= 200) return '#f97316';
  return '#dc2626';
}

function computeSimpleAQI(measurements) {
  const pm25 = measurements.find(m => m.parameter === 'pm25');
  const pm10 = measurements.find(m => m.parameter === 'pm10');
  const v = pm25 ? pm25.value : (pm10 ? pm10.value : null);
  if (v === null || v === undefined) return null;
  // simplified breakpoints mapping (approx)
  if (v <= 12) return Math.round(25 * v / 12);
  if (v <= 35.4) return Math.round(50 + (50 * (v - 12) / (35.4 - 12)));
  if (v <= 55.4) return Math.round(100 + (100 * (v - 35.4) / (55.4 - 35.4)));
  return Math.round(200 + (200 * (v - 55.4) / 100));
}

function safeDestroyChart() {
  if (!chart) return;
  try { chart.destroy(); } catch (e) { console.warn('chart destroy err', e); }
  chart = null;
}

function renderChart(measurements, computedAQI) {
  if (!ctx) return;
  const labels = measurements.map(m => m.parameter + (m.unit ? ` (${m.unit})` : ''));
  const values = measurements.map(m => (typeof m.value === 'number' ? m.value : null));
  // choose colors: use aqiColor for bars if computedAQI present, else neutral per-bar color
  const barColor = computedAQI != null ? aqiColor(computedAQI) : '#6b7280';
  const bgColors = values.map(() => barColor);

  safeDestroyChart();
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded, skipping chart render');
    return;
  }

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Latest values',
        data: values,
        backgroundColor: bgColors,
        borderRadius: 6,
        barThickness: 'flex'
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } }
    }
  });
}

// fetch with timeout
function fetchWithTimeout(url, opts = {}, timeout = 10000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
  ]);
}

async function doFetch(city, attempt = 1) {
  setStatus(`Loading... (attempt ${attempt})`);
  if (cityName) cityName.textContent = city;
  try {
    console.log('[fetch] requesting /api/aqi?city=' + city);
    const res = await fetchWithTimeout(`/api/aqi?city=${encodeURIComponent(city)}`, {}, 12000);

    // non-OK handling
    if (!res.ok) {
      const txt = await res.text().catch(() => null);
      console.error('[fetch] bad status', res.status, txt);
      setStatus(`Server returned ${res.status}`);
      if (aqiValue) aqiValue.textContent = '—';
      if (aqiDesc) aqiDesc.textContent = txt || 'No data';
      renderChart([], null);
      return;
    }

    // ensure the response is JSON (defensive)
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      const txt = await res.text().catch(() => null);
      console.error('[fetch] unexpected content-type', ctype, txt && txt.slice(0, 200));
      setStatus('Unexpected response from server');
      if (aqiValue) aqiValue.textContent = '—';
      if (aqiDesc) aqiDesc.textContent = 'Server returned non-JSON';
      renderChart([], null);
      return;
    }

    const data = await res.json().catch(err => {
      console.error('[fetch] json parse error', err);
      return null;
    });

    if (!data) {
      setStatus('Invalid JSON from server');
      if (aqiValue) aqiValue.textContent = '—';
      if (aqiDesc) aqiDesc.textContent = 'Invalid JSON';
      renderChart([], null);
      return;
    }

    console.log('[fetch] data', data);
    const m = Array.isArray(data.measurements) ? data.measurements : [];
    const computed = (typeof data.computedAQI === 'number') ? data.computedAQI : computeSimpleAQI(m);

    // empty measurements handling
    if (!m || m.length === 0) {
      if (aqiValue) aqiValue.textContent = '—';
      if (aqiDesc) aqiDesc.textContent = 'No pollutant data returned';
      if (aqiValue) aqiValue.style.background = '#6b7280';
      renderChart([], computed);
      setStatus('No measurements returned');
      return;
    }

    // display computed or fallback
    if (computed === null) {
      if (aqiValue) aqiValue.textContent = '—';
      if (aqiDesc) aqiDesc.textContent = 'PM2.5/PM10 missing — showing available pollutants';
      if (aqiValue) aqiValue.style.background = '#6b7280';
    } else {
      if (aqiValue) aqiValue.textContent = computed;
      if (aqiDesc) aqiDesc.textContent = computed <= 50 ? 'Good' :
                                              computed <= 100 ? 'Moderate' :
                                              computed <= 200 ? 'Unhealthy' : 'Very Unhealthy';
      if (aqiValue) aqiValue.style.background = aqiColor(computed);
    }

    renderChart(m, computed);
    setStatus('Updated');
  } catch (err) {
    console.error('[fetch] error', err);
    if (err && err.message === 'timeout') setStatus('Request timed out');
    else setStatus('Network error');

    // retry once after short delay
    if (attempt < 2) {
      setTimeout(() => doFetch(city, attempt + 1), 5000);
    } else {
      if (aqiValue) aqiValue.textContent = '—';
      if (aqiDesc) aqiDesc.textContent = 'Unable to fetch AQI data right now.';
      renderChart([], null);
    }
  }
}

// attach
fetchBtn && fetchBtn.addEventListener('click', () => {
  const city = (cityInput && cityInput.value || '').trim() || 'Delhi'; // default
  if (!city) { setStatus('Enter a city'); return; }
  doFetch(city);
});

// auto run on load (fetch default if no input)
window.addEventListener('load', () => {
  try {
    // prefer value in input if present, else default to Delhi
    const initialCity = (cityInput && cityInput.value || '').trim() || 'Delhi';
    if (fetchBtn) {
      // update the input so UI shows the city
      if (cityInput) cityInput.value = initialCity;
      fetchBtn.click();
    } else {
      // if there's no button, call directly
      doFetch(initialCity);
    }
  } catch (e) {
    console.error(e);
  }
});
