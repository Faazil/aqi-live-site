// backend/public/script.js
// Multi-city dashboard: buttons for cities, center highlight shows highest AQI
// Uses existing backend endpoint: /api/aqi?city=<CityName>
// Paste this file to replace your existing script.js

// --------- Config: list of Indian cities to show on the dashboard ----------
const CITY_LIST = [
  'Delhi','Mumbai','Bengaluru','Kolkata','Chennai','Hyderabad','Pune','Ahmedabad',
  'Lucknow','Jaipur','Kanpur','Nagpur','Indore','Bhopal','Patna','Surat',
  'Vadodara','Visakhapatnam','Coimbatore','Ludhiana','Agra','Nashik','Faridabad',
  'Meerut','Rajkot','Kochi','Varanasi','Srinagar','Amritsar','Guwahati'
];
// You can edit the list above to add/remove cities

// ---------- Utility: remove static placeholder text if exists ----------
(function removeStaticLoadingText() {
  try {
    const all = Array.from(document.querySelectorAll('body *'));
    for (const el of all) {
      if (!el.children.length) {
        const txt = (el.textContent || '').trim();
        if (txt === 'Loading AQI data...' || txt === 'Loading AQI data…') {
          el.textContent = '';
          el.style.display = 'none';
          console.info('[init] removed static placeholder from', el);
        }
      }
    }
  } catch (e) {
    console.warn('[init] error removing static placeholder', e);
  }
})();

// ---------- Small helpers to ensure DOM elements exist or create them ----------
function ensureEl(id, tag = 'div', attrs = {}) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
    const container = document.querySelector('main') || document.querySelector('.container') || document.body;
    container.appendChild(el);
    console.info(`[init] created missing element #${id}`);
  }
  return el;
}

// ---------- Inject spinner CSS ----------
(function injectSpinnerCSS() {
  if (document.getElementById('aqi-spinner-css')) return;
  const css = `
  /* spinner + layout helpers */
  #spinner { display:none; align-items:center; justify-content:center; }
  .spinner-dot {
    width:14px; height:14px; margin:4px; border-radius:50%;
    background:#2563eb; opacity:0.9; animation:spinner-bounce 1s infinite ease-in-out;
  }
  .spinner-dot:nth-child(2){ background:#16a34a; animation-delay:0.15s }
  .spinner-dot:nth-child(3){ background:#f59e0b; animation-delay:0.30s }
  @keyframes spinner-bounce { 0% { transform: translateY(0); } 50% { transform: translateY(-8px); } 100% { transform: translateY(0); } }
  .aqi-loading { opacity: 0.95; transition: opacity 200ms; }
  /* layout for button grid and highlight card */
  #city-buttons { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin:12px 0; }
  .city-btn {
    padding:8px 12px; border-radius:6px; border:1px solid #ddd; background:#fff; cursor:pointer;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03); font-weight:600; user-select:none;
  }
  .city-btn:hover { transform: translateY(-2px); }
  .city-btn.active { box-shadow: 0 6px 18px rgba(0,0,0,0.12); transform:none; border-color:#bbb; }
  #highlight-card { text-align:center; margin:8px auto 20px; max-width:420px; padding:14px; border-radius:6px; background:#fff; box-shadow:0 6px 18px rgba(0,0,0,0.06); }
  #highlight-city { font-weight:700; margin-top:6px; }
  #aqi-value { display:inline-block; padding:6px 8px; color:#111; border-radius:4px; font-size:40px; margin:8px 0; min-width:64px; }
  #aqi-desc { margin-bottom:6px; color:#444; }
  #city-buttons-wrapper { display:flex; justify-content:center; }
  `;
  const s = document.createElement('style');
  s.id = 'aqi-spinner-css';
  s.appendChild(document.createTextNode(css));
  document.head.appendChild(s);
})();

// ---------- UI Elements: ensure existence ----------
const cityInput = document.getElementById('city') || (function(){
  const input = document.createElement('input'); input.id='city'; input.placeholder='City';
  input.style.display='none';
  document.body.appendChild(input);
  return input;
})();

const fetchBtn = document.getElementById('fetchBtn') || null;
const statusDiv = ensureEl('status', 'div', { role: 'status' });
statusDiv.classList.add('aqi-loading');
statusDiv.style.textAlign = 'center';

// spinner
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

// highlight and details
const highlightCard = ensureEl('highlight-card', 'div');
highlightCard.id = 'highlight-card';
const highlightCityEl = ensureEl('highlight-city', 'div');
highlightCityEl.id = 'highlight-city';
const highlightAqiEl = ensureEl('aqi-value', 'div');
highlightAqiEl.id = 'aqi-value';
const highlightDescEl = ensureEl('aqi-desc', 'div');
highlightDescEl.id = 'aqi-desc';

// chart canvas area (create canvas if not present)
let canvas = document.getElementById('aqiChart');
if (!canvas) {
  const c = document.createElement('canvas'); c.id = 'aqiChart'; c.width = 480; c.height = 200;
  // place the canvas inside highlight-card after aqi-value
  highlightCard.appendChild(c);
  canvas = c;
}
const ctx = canvas ? canvas.getContext('2d') : null;
let chart = null;

// container for city buttons
const cityButtonsWrapper = ensureEl('city-buttons-wrapper', 'div');
const cityButtons = ensureEl('city-buttons', 'div', {});
cityButtonsWrapper.appendChild(cityButtons);

// place highlight card and status properly in DOM (near each other)
highlightCard.appendChild(highlightCityEl);
highlightCard.appendChild(highlightAqiEl);
highlightCard.appendChild(highlightDescEl);
statusDiv.parentNode && statusDiv.parentNode.insertBefore(highlightCard, statusDiv.nextSibling);
statusDiv.parentNode && statusDiv.parentNode.insertBefore(cityButtonsWrapper, highlightCard.nextSibling);

// ---------- helper functions ----------
function setStatus(text) {
  try {
    if (statusDiv) {
      if (spinnerEl && spinnerEl.parentNode === statusDiv) {
        Array.from(statusDiv.childNodes).forEach(node => { if (node !== spinnerEl) node.remove(); });
        statusDiv.insertBefore(document.createTextNode(text), spinnerEl);
      } else {
        statusDiv.textContent = text;
      }
    }
  } catch (e) { console.warn('[UI] setStatus error', e); }
  console.log('[UI] status:', text);
}
function showSpinner() { if (spinnerEl) spinnerEl.style.display = 'flex'; }
function hideSpinner() { if (spinnerEl) spinnerEl.style.display = 'none'; }

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
  if (!ctx) return;
  const labels = measurements.map(m => m.parameter + (m.unit ? ` (${m.unit})` : ''));
  const values = measurements.map(m => (typeof m.value === 'number' ? m.value : 0));
  const barColor = computedAQI != null ? aqiColor(computedAQI) : '#6b7280';
  const bgColors = values.map(() => barColor);
  safeDestroyChart();
  if (typeof Chart === 'undefined') return;
  chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Latest values', data: values, backgroundColor: bgColors }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}

// ---------- Fetch helpers: batching / concurrency ----------
function fetchWithTimeout(url, opts = {}, timeout = 10000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
  ]);
}

async function fetchCityData(city, attempt = 1) {
  // Uses existing backend endpoint
  const endpoint = `/api/aqi?city=${encodeURIComponent(city)}`;
  try {
    const res = await fetchWithTimeout(endpoint, {}, 12000);
    if (!res.ok) {
      const txt = await res.text().catch(()=>null);
      console.warn('[fetchCityData] bad status', city, res.status, txt && txt.slice(0,200));
      return { city, error: `status ${res.status}` };
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      const txt = await res.text().catch(()=>null);
      console.warn('[fetchCityData] non-json', city, ctype, txt && txt.slice(0,200));
      return { city, error: 'non-json-response' };
    }
    const data = await res.json();
    // normalize shape
    const measurements = Array.isArray(data.measurements) ? data.measurements : [];
    const computed = (typeof data.computedAQI === 'number') ? data.computedAQI : computeSimpleAQI(measurements);
    return { city, computedAQI: computed, measurements, raw: data };
  } catch (err) {
    console.warn('[fetchCityData] error', city, err && err.message);
    if (attempt < 2) {
      // small retry
      await new Promise(r => setTimeout(r, 1500));
      return fetchCityData(city, attempt+1);
    }
    return { city, error: err && (err.message || String(err)) };
  }
}

// concurrency-limited batch runner
async function batchFetchCities(cities, concurrency = 4) {
  const results = [];
  let idx = 0;
  const running = new Set();
  async function runOne(i) {
    const c = cities[i];
    running.add(i);
    try {
      const r = await fetchCityData(c);
      results[i] = r;
    } finally {
      running.delete(i);
    }
  }
  // start up to concurrency tasks
  const starters = [];
  while (idx < cities.length && starters.length < concurrency) {
    starters.push(runOne(idx));
    idx++;
  }
  // as tasks finish, start new ones
  while (idx < cities.length) {
    // wait for any running to settle
    await Promise.race(Array.from(running).map(i => Promise.resolve()));
    // start next
    starters.push(runOne(idx));
    idx++;
  }
  // wait for all to finish
  await Promise.all(starters);
  return results;
}

// ---------- Dashboard rendering ----------
const cache = new Map(); // cache city -> result for page session

function createCityButton(city, displayText) {
  const btn = document.createElement('button');
  btn.className = 'city-btn';
  btn.textContent = displayText || city;
  btn.dataset.city = city;
  btn.addEventListener('click', () => {
    // activate style
    Array.from(cityButtons.children).forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    // show city details (from cache if present)
    const cached = cache.get(city);
    if (cached && !cached.error) {
      showCityInHighlight(cached);
    } else {
      // fetch if not in cache
      showCityLoading(city);
      fetchCityData(city).then(r => {
        cache.set(city, r);
        if (!r.error) showCityInHighlight(r);
        else showCityError(r);
      });
    }
  });
  return btn;
}

function showCityLoading(city) {
  highlightCityEl.textContent = city;
  highlightAqiEl.textContent = '—';
  highlightDescEl.textContent = 'Loading...';
  highlightAqiEl.style.background = '#6b7280';
  renderChart([], null);
  setStatus(`Loading ${city}...`);
  showSpinner();
}

function showCityError(r) {
  highlightCityEl.textContent = r.city;
  highlightAqiEl.textContent = '—';
  highlightDescEl.textContent = `Error: ${r.error || 'unknown'}`;
  highlightAqiEl.style.background = '#6b7280';
  renderChart([], null);
  setStatus(`Error for ${r.city}`);
  hideSpinner();
}

function showCityInHighlight(r) {
  hideSpinner();
  const computed = r.computedAQI;
  highlightCityEl.textContent = r.city;
  if (computed === null || computed === undefined) {
    highlightAqiEl.textContent = '—';
    highlightDescEl.textContent = 'PM2.5/PM10 missing — showing available pollutants';
    highlightAqiEl.style.background = '#6b7280';
  } else {
    highlightAqiEl.textContent = computed;
    highlightDescEl.textContent = computed <= 50 ? 'Good' : computed <= 100 ? 'Moderate' : computed <= 200 ? 'Unhealthy' : 'Very Unhealthy';
    highlightAqiEl.style.background = aqiColor(computed);
  }
  renderChart(Array.isArray(r.measurements) ? r.measurements : [], computed);
  setStatus(`Updated: ${r.city}`);
}

// ---------- Initialization: create buttons and auto-fetch all ----------
function buildCityButtons(cities) {
  cityButtons.innerHTML = '';
  for (const city of cities) {
    const btn = createCityButton(city, city);
    cityButtons.appendChild(btn);
  }
}

async function initDashboard() {
  try {
    setStatus('Fetching city list...');
    showSpinner();
    buildCityButtons(CITY_LIST);

    // Fetch all cities in batches with concurrency limit
    setStatus('Loading AQI for cities (this may take a few seconds)...');
    // We'll fetch with concurrency 4 to be polite to upstream
    const results = await batchFetchCities(CITY_LIST, 4);

    // store into cache and compute highest
    let best = null; // best = item with highest computedAQI
    for (const r of results) {
      cache.set(r.city, r);
      if (!r.error && typeof r.computedAQI === 'number') {
        if (!best || r.computedAQI > best.computedAQI) best = r;
      }
    }

    // annotate buttons with small badge (AQI)
    for (const btn of Array.from(cityButtons.children)) {
      const city = btn.dataset.city;
      const r = cache.get(city);
      // remove existing badge if any
      const existingBadge = btn.querySelector('.badge-aqi');
      if (existingBadge) existingBadge.remove();
      const badge = document.createElement('span');
      badge.className = 'badge-aqi';
      badge.style.marginLeft = '8px';
      badge.style.fontSize = '12px';
      badge.style.padding = '2px 6px';
      badge.style.borderRadius = '999px';
      badge.style.background = '#f3f4f6';
      badge.style.border = '1px solid #eee';
      badge.style.fontWeight = '600';
      if (!r || r.error || r.computedAQI === null || r.computedAQI === undefined) {
        badge.textContent = '—';
      } else {
        badge.textContent = String(r.computedAQI);
        badge.style.background = aqiColor(r.computedAQI);
        badge.style.color = '#fff';
      }
      badge.classList.add('badge-aqi');
      btn.appendChild(badge);
    }

    if (best) {
      // activate button for best and show it in highlight
      const bestBtn = Array.from(cityButtons.children).find(b => b.dataset.city === best.city);
      if (bestBtn) bestBtn.classList.add('active');
      showCityInHighlight(best);
    } else {
      // no data, show default city (Delhi)
      const defaultCity = 'Delhi';
      const r = cache.get(defaultCity) || (await fetchCityData(defaultCity));
      cache.set(defaultCity, r);
      if (r && !r.error) showCityInHighlight(r);
      else setStatus('No city data available');
    }
  } catch (e) {
    console.error('[initDashboard] error', e);
    setStatus('Failed to initialize dashboard');
  } finally {
    hideSpinner();
  }
}

// attach click if there's a dedicated fetch button (keeps backward compatibility)
if (fetchBtn) {
  fetchBtn.addEventListener('click', () => {
    const city = (cityInput.value || '').trim() || 'Delhi';
    if (!city) { setStatus('Enter a city'); return; }
    // fetch single
    showCityLoading(city);
    fetchCityData(city).then(r => {
      cache.set(city, r);
      if (!r.error) showCityInHighlight(r);
      else showCityError(r);
    });
  });
}

// Auto-run on load
window.addEventListener('load', () => {
  try {
    setTimeout(() => initDashboard(), 100); // small delay so DOM stabilizes
  } catch (e) {
    console.error('[init] startup error', e);
  }
});
