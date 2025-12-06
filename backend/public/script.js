// script.js - replaces backend/public/script.js
// Multi-city dashboard + search + redesigned layout
// Expects index.html structure from the provided template
// Uses backend endpoint: /api/aqi?city=CityName

/* ---------- Configuration ---------- */
const CITY_LIST = [
  'Delhi','Mumbai','Bengaluru','Kolkata','Chennai','Hyderabad','Pune','Ahmedabad',
  'Lucknow','Jaipur','Kanpur','Nagpur','Indore','Bhopal','Patna','Surat',
  'Vadodara','Visakhapatnam','Coimbatore','Ludhiana','Agra','Nashik','Faridabad',
  'Meerut','Rajkot','Kochi','Varanasi','Srinagar','Amritsar','Guwahati'
];
const FETCH_CONCURRENCY = 4;

/* ---------- DOM references ---------- */
const searchBox = document.getElementById('searchBox');
const searchBtn = document.getElementById('searchBtn');
const refreshBtn = document.getElementById('refreshBtn');

const statusText = document.getElementById('status-text');
const spinner = document.getElementById('spinner');

const cityButtons = document.getElementById('city-buttons');

const highlightCity = document.getElementById('highlight-city');
const aqiValue = document.getElementById('aqi-value');
const aqiDesc = document.getElementById('aqi-desc');
const lastUpdated = document.getElementById('last-updated');

const canvas = document.getElementById('aqiChart');
const ctx = canvas ? canvas.getContext('2d') : null;
let chart = null;

/* ---------- Helpers ---------- */
function log(...args){ console.info('[aqi]', ...args); }

function showSpinner(){ spinner.style.display = 'inline-flex'; }
function hideSpinner(){ spinner.style.display = 'none'; }
function setStatus(text){ statusText.textContent = text; log(text); }

/* AQI color helper */
function aqiColor(aqi){
  if(aqi===null || aqi===undefined) return '#6b7280';
  if(aqi<=50) return '#16a34a';
  if(aqi<=100) return '#f59e0b';
  if(aqi<=200) return '#f97316';
  return '#dc2626';
}

/* Compute simple AQI fallback (used if backend doesn't return computedAQI) */
function computeSimpleAQI(measurements){
  const pm25 = measurements.find(m=>m.parameter==='pm25');
  const pm10 = measurements.find(m=>m.parameter==='pm10');
  const v = pm25 ? pm25.value : (pm10 ? pm10.value : null);
  if(v===null || v===undefined) return null;
  if(v<=12) return Math.round(25 * v/12);
  if(v<=35.4) return Math.round(50 + (50*(v-12)/(35.4-12)));
  if(v<=55.4) return Math.round(100 + (100*(v-35.4)/(55.4-35.4)));
  return Math.round(200 + (200*(v-55.4)/100));
}

/* Chart helpers */
function safeDestroyChart(){ if(!chart) return; try{ chart.destroy(); }catch(e){console.warn(e);} chart=null; }
function renderChart(measurements, computedAQI){
  if(!ctx){ console.debug('No chart canvas'); return; }
  const labels = measurements.map(m => m.parameter + (m.unit ? ` (${m.unit})` : ''));
  const values = measurements.map(m => typeof m.value === 'number' ? m.value : 0);
  const color = computedAQI != null ? aqiColor(computedAQI) : '#6b7280';
  const bg = values.map(()=>color);
  safeDestroyChart();
  if(typeof Chart === 'undefined'){ console.warn('Chart.js missing'); return; }
  chart = new Chart(ctx, {
    type:'bar',
    data:{ labels, datasets:[{ label:'Latest', data:values, backgroundColor:bg }]},
    options:{ responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}}}
  });
}

/* fetch with timeout */
function fetchWithTimeout(url, opts={}, timeout=12000){
  return Promise.race([ fetch(url, opts), new Promise((_, rej)=>setTimeout(()=>rej(new Error('timeout')), timeout)) ]);
}

/* fetch single city data via existing backend endpoint */
async function fetchCityData(city, attempt=1){
  try{
    const url = `/api/aqi?city=${encodeURIComponent(city)}`;
    const res = await fetchWithTimeout(url, {}, 12000);
    if(!res.ok){
      const txt = await res.text().catch(()=>null);
      return { city, error: `status ${res.status}`, rawText: txt };
    }
    const ctype = res.headers.get('content-type') || '';
    if(!ctype.includes('application/json')) {
      const txt = await res.text().catch(()=>null);
      return { city, error: 'non-json', rawText: txt };
    }
    const json = await res.json();
    const measurements = Array.isArray(json.measurements) ? json.measurements : [];
    const computed = (typeof json.computedAQI === 'number') ? json.computedAQI : computeSimpleAQI(measurements);
    return { city, computedAQI: computed, measurements, raw: json };
  } catch (err) {
    if(attempt < 2){ await new Promise(r=>setTimeout(r,800)); return fetchCityData(city, attempt+1); }
    return { city, error: err && err.message ? err.message : String(err) };
  }
}

/* concurrency-limited batch fetch */
async function batchFetch(cities, concurrency=4){
  const out = new Array(cities.length);
  let i = 0;
  const workers = new Array(Math.min(concurrency, cities.length)).fill().map(async ()=> {
    while(i < cities.length){
      const idx = i++;
      out[idx] = await fetchCityData(cities[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- UI building & interactions ---------- */
const cache = new Map();

function makeCityButton(city){
  const btn = document.createElement('button');
  btn.className = 'city-btn';
  btn.type = 'button';
  btn.dataset.city = city;
  btn.textContent = city;
  btn.addEventListener('click', () => {
    // activate
    Array.from(cityButtons.children).forEach(c=>c.classList.remove('active'));
    btn.classList.add('active');
    const cached = cache.get(city);
    if(cached && !cached.error){ showCity(cached); }
    else{ showLoading(city); fetchCityData(city).then(r=>{ cache.set(city, r); if(!r.error) showCity(r); else showError(r); }); }
  });
  return btn;
}

function showLoading(city){
  highlightCity.textContent = city;
  aqiValue.textContent = '—'; aqiValue.style.background = '#6b7280';
  aqiDesc.textContent = 'Loading...';
  lastUpdated.textContent = '';
  renderChart([], null);
  setStatus(`Loading ${city}...`);
  showSpinner();
}

function showError(r){
  hideSpinner();
  highlightCity.textContent = r.city;
  aqiValue.textContent = '—'; aqiValue.style.background = '#6b7280';
  aqiDesc.textContent = `Error: ${r.error || 'unknown'}`;
  lastUpdated.textContent = '';
  renderChart([], null);
  setStatus(`Failed to load ${r.city}`);
}

function showCity(r){
  hideSpinner();
  const computed = r.computedAQI;
  highlightCity.textContent = r.city;
  if(computed === null || computed === undefined){
    aqiValue.textContent = '—';
    aqiDesc.textContent = 'PM2.5/PM10 missing — showing pollutants';
    aqiValue.style.background = '#6b7280';
  } else {
    aqiValue.textContent = computed;
    aqiDesc.textContent = computed <=50 ? 'Good' : computed <=100 ? 'Moderate' : computed <=200 ? 'Unhealthy' : 'Very Unhealthy';
    aqiValue.style.background = aqiColor(computed);
  }
  if(r.raw && r.raw.measurements && r.raw.measurements.length){
    // optional: find lastUpdated if present in raw
    const lu = r.raw.measurements[0] && r.raw.measurements[0].lastUpdated;
    lastUpdated.textContent = lu ? `Updated: ${lu}` : '';
  } else lastUpdated.textContent = '';
  renderChart(Array.isArray(r.measurements) ? r.measurements : [], computed);
  setStatus(`Updated: ${r.city}`);
}

/* populate city buttons list */
function buildButtons(cities){
  cityButtons.innerHTML = '';
  for(const c of cities){
    const btn = makeCityButton(c);
    cityButtons.appendChild(btn);
  }
}

/* annotate buttons with badge values from cache */
function annotateBadges(){
  for(const btn of Array.from(cityButtons.children)){
    const city = btn.dataset.city;
    // remove existing badge
    const existing = btn.querySelector('.badge');
    if(existing) existing.remove();
    const r = cache.get(city);
    const badge = document.createElement('span');
    badge.className = 'badge';
    if(!r || r.error || typeof r.computedAQI !== 'number'){
      badge.textContent = '—';
      badge.style.background = '#f3f4f6'; badge.style.color='#000';
    } else {
      badge.textContent = String(r.computedAQI);
      badge.style.background = aqiColor(r.computedAQI);
      badge.style.color = '#fff';
    }
    btn.appendChild(badge);
  }
}

/* find highest AQI and show it */
function showHighest(){
  let best = null;
  for(const [k,v] of cache.entries()){
    if(!v || v.error || typeof v.computedAQI !== 'number') continue;
    if(!best || v.computedAQI > best.computedAQI) best = v;
  }
  if(best){
    // activate button
    const btn = Array.from(cityButtons.children).find(b=>b.dataset.city===best.city);
    if(btn){ Array.from(cityButtons.children).forEach(c=>c.classList.remove('active')); btn.classList.add('active'); }
    showCity(best);
  } else {
    // fallback to Delhi
    const fallback = cache.get('Delhi');
    if(fallback) showCity(fallback);
  }
}

/* ---------- Initialization & actions ---------- */
async function init(){
  try{
    buildButtons(CITY_LIST);
    setStatus('Fetching city data...');
    showSpinner();
    // fetch in batches
    const results = await batchFetch(CITY_LIST, FETCH_CONCURRENCY);
    for(const r of results) cache.set(r.city, r);
    annotateBadges();
    showHighest();
  } catch(e){
    console.error(e);
    setStatus('Failed to load cities');
  } finally {
    hideSpinner();
  }
}

/* manual search handler */
async function doSearch(city){
  if(!city || !city.trim()) return;
  const normalized = city.trim();
  // if already cached, just show it
  const cached = cache.get(normalized);
  if(cached && !cached.error){ // show and set active
    const btn = Array.from(cityButtons.children).find(b=>b.dataset.city===normalized);
    if(btn){ Array.from(cityButtons.children).forEach(c=>c.classList.remove('active')); btn.classList.add('active'); }
    showCity(cached);
    return;
  }
  // else show loading and fetch
  showLoading(normalized);
  const r = await fetchCityData(normalized);
  cache.set(normalized, r);
  // if city not in button list, add a button
  if(!Array.from(cityButtons.children).find(b=>b.dataset.city===normalized)){
    const nb = makeCityButton(normalized);
    cityButtons.prepend(nb);
  }
  annotateBadges();
  if(!r.error) showCity(r); else showError(r);
}

/* refresh all */
async function refreshAll(){
  setStatus('Refreshing all cities...');
  showSpinner();
  try{
    const results = await batchFetch(CITY_LIST, FETCH_CONCURRENCY);
    for(const r of results) cache.set(r.city, r);
    annotateBadges();
    showHighest();
  } catch(e){ console.error(e); setStatus('Refresh failed'); }
  finally{ hideSpinner(); }
}

/* event wiring */
searchBtn.addEventListener('click', ()=>doSearch(searchBox.value));
searchBox.addEventListener('keydown', (ev)=>{ if(ev.key === 'Enter') doSearch(searchBox.value); });
refreshBtn.addEventListener('click', ()=>refreshAll());

/* start */
window.addEventListener('load', ()=>init());
