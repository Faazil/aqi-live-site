// backend/public/script.js (updated with spinner + stronger logging)

// ----- small helper to ensure DOM elements exist or create them -----
function ensureEl(id, tag = 'div', attrs = {}) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
    // Try to place near main content or at body end
    const container = document.querySelector('main') || document.querySelector('.container') || document.body;
    container.appendChild(el);
    console.info(`[init] created missing element #${id}`);
  }
  return el;
}

// inject minimal spinner CSS once
(function injectSpinnerCSS() {
  if (document.getElementById('aqi-spinner-css')) return;
  const css = `
  #spinner { display:none; align-items:center; justify-content:center; }
  .spinner-dot {
    width:14px; height:14px; margin:4px; border-radius:50%;
    background:#2563eb; opacity:0.9; animation:spinner-bounce 1s infinite ease-in-out;
  }
  .spinner-dot:nth-child(2){ background:#16a34a; animation-delay:0.15s }
  .spinner-dot:nth-child(3){ background:#f59e0b; animation-delay:0.30s }
  @keyframes spinner-bounce { 0% { transform: translateY(0); } 50% { transform: translateY(-8px); } 100% { transform: translateY(0); } }
  .aqi-loading { opacity: 0.8; transition: opacity 200ms; }
  `;
  const s = document.createElement('style');
  s.id = 'aqi-spinner-css';
  s.appendChild(document.createTextNode(css));
  document.head.appendChild(s);
})();

// primary UI elements (create if missing)
const cityInput = document.getElementById('city') || (function(){
  const input = document.createElement('input'); input.id='city'; input.placeholder='City';
  // keep it hidden if layout doesn't expect it
  input.style.display='none';
  document.body.appendChild(input);
  return input;
})();

const fetchBtn = document.getElementById('fetchBtn') || null;

// status area: ensure exists and has spinner
const statusDiv = ensureEl('status', 'div', { role: 'status' });
statusDiv.classList.add('aqi-loading');
statusDiv.style.marginTop = statusDiv.style.marginTop || '10px';
statusDiv.style.textAlign = statusDiv.style.textAlign || 'center';
statusDiv.style.fontSize = statusDiv.style.fontSize || '14px';

// ensure spinner element inside status
let spinnerEl = document.getElementById('spinner');
if (!spinnerEl) {
  spinnerEl = document.createElement('div');
  spinnerEl.id = 'spinner';
  spinnerEl.style.display = 'none';
  spinnerEl.style.margin = '8px auto';
  spinnerEl.style.width = '70px';
  spinnerEl.style.height = '28px';
  spinnerEl.style.justifyContent = 'center';
  spinnerEl.style.alignItems = 'center';
  spinnerEl.style.display = 'flex';
  spinnerEl.innerHTML = '<div class="spinner-dot"></div><div class="spinner-dot"></div><div class="spinner-dot"></div>';
  statusDiv.appendChild(spinnerEl);
}

// cityName / aqi display elements (create if missing)
const cityName = document.getElementById('city-name') || (function(){
  const el = document.createElement('div'); el.id='city-name'; el.style.fontWeight='600'; statusDiv.parentNode && statusDiv.parentNode.insertBefore(el, statusDiv);
  return el;
})();
const aqiValue = document.getElementById('aqi-value') || (function(){
  const el = document.createElement('div'); el.id='aqi-value'; el.textContent='—'; el.style.fontSize='36px'; el.style.margin='8px 0'; el.style.display='inline-block';
  statusDiv.parentNode && statusDiv.parentNode.insertBefore(el, statusDiv);
  return el;
})();
const aqiDesc = document.getElementById('aqi-desc') || (function(){
  const el = document.createElement('div'); el.id='aqi-desc'; el.style.marginBottom='8px'; statusDiv.parentNode && statusDiv.parentNode.insertBefore(el, statusDiv);
  return el;
})();

const canvas = document.getElementById('aqiChart');
const ctx = canvas ? canvas.getContext('2d') : null;
let chart = null;

// ---- helpers ----
function setStatus(text) {
  if (statusDiv) statusDiv.childNodes[0] && statusDiv.childNodes[0].nodeType===3 ? statusDiv.childNodes[0].nodeValue = text : statusDiv.insertBefore(document.createTextNode(text), spinnerEl);
  console.log('[UI] status:', text);
}
function showSpinner() { spinnerEl.style.display = 'flex'; }
function hideSpinner() { spinnerEl.style.display = 'none'; }

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
  if (!ctx) {
    // no chart canvas — skip but keep debug info
    console.debug('[chart] no canvas available, measurements:', measurements);
    return;
  }
  const labels = measurements.map(m => m.parameter + (m.unit ? ` (${m.unit})` : ''));
  const values = measurements.map(m => (typeof m.value === 'number' ? m.value : 0));
  const barColor = computedAQI != null ? aqiColor(computedAQI) : '#6b7280';
  const bgColors = values.map(() => barColor);
  safeDestroyChart();
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded; skipping chart render');
    return;
  }
  chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Latest values', data: values, backgroundColor: bgColors }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
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
  try {
    setStatus(`Loading... (attempt ${attempt})`);
    showSpinner();
    if (cityName) cityName.textContent = city;
    console.info(`[fetch] requesting /api/aqi?city=${city} (attempt ${attempt})`);
    const res = await fetchWithTimeout(`/api/aqi?city=${encodeURIComponent(city)}`, {}, 12000);

    // check status
    if (!res.ok) {
      const txt = await res.text().catch(() => null);
      console.error('[fetch] bad status', res.status, txt && txt.slice(0,200));
      setStatus(`Server returned ${res.status}`);
      aqiValue.textContent = '—';
      aqiDesc.textContent = txt || 'No data';
      renderChart([], null);
      hideSpinner();
      return;
    }

    // validate content-type
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      const txt = await res.text().catch(() => null);
      console.error('[fetch] unexpected content-type', ctype, txt && txt.slice(0,200));
      setStatus('Unexpected response from server');
      aqiValue.textContent = '—';
      aqiDesc.textContent = 'Server returned non-JSON';
      hideSpinner();
      return;
    }

    const data = await res.json().catch(err => { console.error('[fetch] json parse error', err); return null; });
    if (!data) {
      setStatus('Invalid JSON from server');
      aqiValue.textContent = '—';
      aqiDesc.textContent = 'Invalid JSON';
      hideSpinner();
      return;
    }

    console.info('[fetch] success', data);
    const measurements = Array.isArray(data.measurements) ? data.measurements : [];
    const computed = (typeof data.computedAQI === 'number') ? data.computedAQI : computeSimpleAQI(measurements);

    if (!measurements || measurements.length === 0) {
      aqiValue.textContent = '—';
      aqiDesc.textContent = 'No pollutant data returned';
      aqiValue.style.background = '#6b7280';
      setStatus('No measurements returned');
      renderChart([], computed);
      hideSpinner();
      return;
    }

    // display AQI
    if (computed === null) {
      aqiValue.textContent = '—';
      aqiDesc.textContent = 'PM2.5/PM10 missing — showing available pollutants';
      aqiValue.style.background = '#6b7280';
    } else {
      aqiValue.textContent = computed;
      aqiDesc.textContent = computed <= 50 ? 'Good' :
                         computed <= 100 ? 'Moderate' :
                         computed <= 200 ? 'Unhealthy' : 'Very Unhealthy';
      aqiValue.style.background = aqiColor(computed);
    }

    renderChart(measurements, computed);
    setStatus('Updated');
    hideSpinner();
  } catch (err) {
    console.error('[fetch] error', err);
    hideSpinner();
    if (err && err.message === 'timeout') setStatus('Request timed out');
    else setStatus('Network error');

    if (attempt < 2) {
      console.info('[fetch] retrying after delay');
      setTimeout(() => doFetch(city, attempt + 1), 4000);
    } else {
      aqiValue.textContent = '—';
      aqiDesc.textContent = 'Unable to fetch AQI data right now.';
      renderChart([], null);
    }
  }
}

// attach click if button exists
if (fetchBtn) {
  fetchBtn.addEventListener('click', () => {
    const city = (cityInput.value || '').trim() || 'Delhi';
    if (!city) { setStatus('Enter a city'); return; }
    doFetch(city);
  });
}

// auto run on load — guaranteed call, logs to console so we can debug
window.addEventListener('load', () => {
  try {
    const initialCity = (cityInput && (cityInput.value || '').trim()) || 'Delhi';
    console.info('[init] auto-fetch for city:', initialCity);
    // if there's a fetch button, keep UI flow; otherwise call directly
    if (fetchBtn) {
      // ensure city input shows value
      if (cityInput) cityInput.value = initialCity;
      fetchBtn.click();
    } else {
      doFetch(initialCity);
    }
  } catch (e) {
    console.error('[init] startup error', e);
  }
});
