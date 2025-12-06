// script.js - full dashboard logic: map, 24h trend cache, auto-refresh, filters, dark mode.
// Uses backend endpoint: /api/aqi?city=<CityName>
// IMPORTANT: serve this at /script.js (or update index.html script src)

const CITY_LIST = [
  'Delhi','Mumbai','Bengaluru','Kolkata','Chennai','Hyderabad','Pune','Ahmedabad',
  'Lucknow','Jaipur','Kanpur','Nagpur','Indore','Bhopal','Patna','Surat',
  'Vadodara','Visakhapatnam','Coimbatore','Ludhiana','Agra','Nashik','Faridabad',
  'Meerut','Rajkot','Kochi','Varanasi','Srinagar','Amritsar','Guwahati'
];

const AUTO_REFRESH_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_CONCURRENCY = 4;
const TREND_RETENTION_MS = 24 * 60 * 60 * 1000; // keep 24 hours of points

/* DOM refs */
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
const pollutantBreakdown = document.getElementById('pollutant-breakdown');

const chartCanvas = document.getElementById('aqiChart');
const chartCtx = chartCanvas ? chartCanvas.getContext('2d') : null;
let chart = null;

const mapEl = document.getElementById('map');
let map = null;
let markers = {}; // city -> marker

/* utility */
function log(...args){ console.info('[aqi]', ...args); }
function setStatus(t){ if(statusText) statusText.textContent = t; log(t); }
function showSpinner(){ if(spinner) spinner.style.display = 'inline-flex'; }
function hideSpinner(){ if(spinner) spinner.style.display = 'none'; }

/* color / category helpers */
function aqiColor(aqi){
  if(aqi === null || aqi === undefined) return '#6b7280';
  if(aqi <= 50) return '#16a34a';
  if(aqi <= 100) return '#f59e0b';
  if(aqi <= 200) return '#f97316';
  return '#dc2626';
}
function aqiCategory(aqi){
  if(aqi === null || aqi === undefined) return 'unknown';
  if(aqi <= 50) return 'good';
  if(aqi <= 100) return 'moderate';
  if(aqi <= 200) return 'unhealthy';
  if(aqi <= 300) return 'very';
  return 'hazardous';
}

/* compute fallback AQI if server doesn't provide */
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

/* persistent trend storage (localStorage) */
function trendKey(city){ return `aqi_trend_${city.toLowerCase()}`; }
function loadTrend(city){
  try {
    const raw = localStorage.getItem(trendKey(city));
    if(!raw) return [];
    const arr = JSON.parse(raw);
    const cutoff = Date.now() - TREND_RETENTION_MS;
    const pruned = arr.filter(p=>p.t >= cutoff);
    localStorage.setItem(trendKey(city), JSON.stringify(pruned));
    return pruned;
  } catch(e){ console.warn('trend load err', e); return []; }
}
function saveTrendPoint(city, value){
  try {
    const key = trendKey(city);
    const arr = loadTrend(city);
    arr.push({ t: Date.now(), v: (typeof value === 'number' ? value : null) });
    localStorage.setItem(key, JSON.stringify(arr));
  } catch(e){ console.warn('trend save err', e); }
}

/* chart rendering */
function safeDestroyChart(){ if(!chart) return; try{ chart.destroy(); }catch(e){console.warn(e);} chart=null; }
function renderPollutantChart(measurements, computedAQI){
  if(!chartCtx) return;
  const labels = measurements.map(m => m.parameter + (m.unit ? ` (${m.unit})` : ''));
  const values = measurements.map(m => (typeof m.value === 'number' ? m.value : 0));
  const color = computedAQI != null ? aqiColor(computedAQI) : '#6b7280';
  const bg = values.map(()=>color);
  safeDestroyChart();
  if(typeof Chart === 'undefined'){ console.warn('Chart.js missing'); return; }
  chart = new Chart(chartCtx, {
    type:'bar',
    data:{ labels, datasets:[{ label:'Latest pollutant values', data: values, backgroundColor: bg }]},
    options:{ responsive:true, plugins:{legend:{display:false}}, scales:{ y:{ beginAtZero:true } } }
  });
}

/* render trend (24h) below chart if data present */
function renderTrend(city){
  const series = loadTrend(city);
  if(!series || series.length === 0) return;
  // make labels for x-axis (hour:minute)
  const labels = series.map(p => {
    const d = new Date(p.t);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
  });
  // create a new canvas below chart for trend
  // We'll draw trend on the same canvas if space low; for brevity we override chart with trend when user clicks 'trend' (not implemented separate UI)
  // For simplicity: append a small trend canvas each time (clean previous)
  let existing = document.getElementById('trendCanvas');
  if(existing) existing.remove();
  const c = document.createElement('canvas'); c.id='trendCanvas'; c.width=600; c.height=140; c.style.marginTop='8px';
  const container = document.getElementById('chart-wrap') || document.getElementById('chart-wrap');
  if(container) container.appendChild(c);
  const cctx = c.getContext('2d');
  if(typeof Chart === 'undefined'){ console.warn('Chart.js missing'); return; }
  new Chart(cctx, {
    type:'line',
    data:{
      labels: labels,
      datasets:[{
        label:'24h AQI',
        data: series.map(s=>s.v),
        fill:false,
        tension:0.2,
        borderColor:'#cc2333',
        pointRadius:3
      }]
    },
    options:{ responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}}}
  });
}

/* pollutant breakdown chips */
function renderPollutantChips(measurements){
  pollutantBreakdown.innerHTML = '';
  if(!measurements || measurements.length === 0) return;
  // show top 6 pollutant chips sorted by value descending
  const top = measurements.slice().sort((a,b)=> (b.value||0) - (a.value||0)).slice(0,6);
  for(const m of top){
    const el = document.createElement('div');
    el.style.padding='6px 8px';
    el.style.borderRadius='999px';
    el.style.background='#fafafa';
    el.style.border='1px solid #eceff3';
    el.style.fontWeight='700';
    el.style.margin='3px';
    el.style.minWidth='80px';
    el.textContent = `${m.parameter.toUpperCase()}: ${m.value}${m.unit ? ' ' + m.unit : ''}`;
    pollutantBreakdown.appendChild(el);
  }
}

/* fetch with timeout */
function fetchWithTimeout(url, opts={}, timeout=12000){
  return Promise.race([ fetch(url, opts), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), timeout)) ]);
}

/* fetch city via backend */
async function fetchCityData(city, attempt=1){
  try {
    const endpoint = `/api/aqi?city=${encodeURIComponent(city)}`;
    const res = await fetchWithTimeout(endpoint, {}, 12000);
    if(!res.ok){
      const txt = await res.text().catch(()=>null);
      return { city, error: `status ${res.status}`, rawText: txt };
    }
    const ctype = res.headers.get('content-type') || '';
    if(!ctype.includes('application/json')){
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

/* batch fetch concurrency */
async function batchFetch(cities, concurrency=4){
  const out = new Array(cities.length);
  let idx = 0;
  const workers = new Array(Math.min(concurrency, cities.length)).fill().map(async ()=>{
    while(idx < cities.length){
      const i = idx++;
      out[i] = await fetchCityData(cities[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/* UI: build buttons */
function createCityButton(city){
  const btn = document.createElement('button');
  btn.className='city-btn';
  btn.type='button';
  btn.dataset.city = city;
  btn.innerHTML = city;
  btn.addEventListener('click', async ()=>{
    // set active
    Array.from(cityButtons.children).forEach(c=>c.classList.remove('active'));
    btn.classList.add('active');
    setStatus(`Loading ${city}...`);
    showSpinner();
    const r = await fetchCityData(city);
    // annotate button with badge
    annotateButtonBadge(btn, r);
    if(r.error){ showCityError(r); hideSpinner(); return; }
    saveTrendPoint(city, r.computedAQI);
    showCity(r);
  });
  return btn;
}

/* annotate badge for a button */
function annotateButtonBadge(btn, r){
  const existing = btn.querySelector('.badge');
  if(existing) existing.remove();
  const badge = document.createElement('span');
  badge.className='badge';
  badge.style.marginLeft='8px';
  badge.style.padding='2px 6px';
  badge.style.borderRadius='999px';
  badge.style.fontWeight='700';
  if(!r || r.error || typeof r.computedAQI !== 'number'){
    badge.textContent = '—'; badge.style.background='#f3f4f6'; badge.style.color='#000';
  } else {
    badge.textContent = String(r.computedAQI);
    badge.style.background = aqiColor(r.computedAQI); badge.style.color = '#fff';
  }
  btn.appendChild(badge);
}

/* place map marker for city (if we have coords). We'll use simple geocoding fallback for major cities (lat/lng map below) */
const CITY_COORDS = {
  'Delhi': [28.7041,77.1025], 'Mumbai':[19.0760,72.8777], 'Bengaluru':[12.9716,77.5946],
  'Kolkata':[22.5726,88.3639], 'Chennai':[13.0827,80.2707], 'Hyderabad':[17.3850,78.4867],
  'Pune':[18.5204,73.8567], 'Ahmedabad':[23.0225,72.5714], 'Lucknow':[26.8467,80.9462],
  'Jaipur':[26.9124,75.7873], 'Kanpur':[26.4499,80.3319], 'Nagpur':[21.1458,79.0882],
  'Indore':[22.7196,75.8577], 'Bhopal':[23.2599,77.4126], 'Patna':[25.5941,85.1376],
  'Surat':[21.1702,72.8311], 'Vadodara':[22.3072,73.1812], 'Visakhapatnam':[17.6868,83.2185],
  'Coimbatore':[11.0168,76.9558],'Ludhiana':[30.9000,75.8573],'Agra':[27.1767,78.0081],
  'Nashik':[19.9975,73.7898],'Faridabad':[28.4089,77.3178],'Meerut':[28.9845,77.7064],
  'Rajkot':[22.3039,70.8022],'Kochi':[9.9312,76.2673],'Varanasi':[25.3176,82.9739],
  'Srinagar':[34.0837,74.7973],'Amritsar':[31.6340,74.8723],'Guwahati':[26.1445,91.7362]
};

/* map init */
function initMap(){
  try {
    map = L.map('map', { zoomControl:true }).setView([22.9734,78.6569], 5.2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  } catch(e){ console.warn('leaflet init failed', e); }
}

/* update or add marker for city */
function upsertMarker(city, aqi, popupHtml){
  if(!map || !CITY_COORDS[city]) return;
  const [lat, lng] = CITY_COORDS[city];
  const color = aqiColor(aqi);
  const icon = L.divIcon({
    html:`<div style="background:${color};color:#fff;padding:6px 8px;border-radius:999px;font-weight:700">${aqi}</div>`,
    className: '',
    iconSize: [50,24], iconAnchor:[25,12]
  });
  if(markers[city]){
    markers[city].setIcon(icon);
    markers[city].setLatLng([lat,lng]);
    markers[city].setPopupContent(popupHtml);
  } else {
    const m = L.marker([lat,lng], { icon }).addTo(map);
    m.bindPopup(popupHtml);
    markers[city] = m;
  }
}

/* show city data in highlight */
function showCity(data){
  hideSpinner();
  highlightCity.textContent = data.city;
  const computed = data.computedAQI;
  if(computed === null || computed === undefined){
    aqiValue.textContent = '—'; aqiValue.style.background = '#6b7280';
    aqiDesc.textContent = 'PM2.5/PM10 missing — showing available';
  } else {
    aqiValue.textContent = computed; aqiValue.style.background = aqiColor(computed);
    aqiDesc.textContent = computed <=50 ? 'Good' : computed <=100 ? 'Moderate' : computed <=200 ? 'Unhealthy' : computed <=300 ? 'Very Unhealthy' : 'Hazardous';
  }
  if(data.raw && data.raw.measurements && data.raw.measurements.length){
    // find lastUpdated
    const lu = data.raw.measurements[0].lastUpdated || (data.raw.time && data.raw.time.s) || null;
    lastUpdated.textContent = lu ? `Updated: ${lu}` : '';
  } else lastUpdated.textContent = '';
  renderPollutantChips(data.measurements);
  renderPollutantChart(data.measurements, data.computedAQI);
  saveTrendPoint(data.city, data.computedAQI);
  renderTrend(data.city);

  // map marker
  const popup = `<strong>${data.city}</strong><br/>AQI: ${data.computedAQI ?? '—'}<br/>${lastUpdated.textContent || ''}`;
  upsertMarker(data.city, data.computedAQI, popup);
}

/* show error UI for city */
function showCityError(r){
  hideSpinner();
  highlightCity.textContent = r.city;
  aqiValue.textContent = '—'; aqiValue.style.background='#6b7280';
  aqiDesc.textContent = `Error: ${r.error || 'unknown'}`;
  lastUpdated.textContent = '';
  pollutantBreakdown.innerHTML = '';
  safeDestroyChart();
}

/* annotate all buttons with badges from cache */
function annotateAllButtons(cache){
  for(const btn of Array.from(cityButtons.children)){
    const city = btn.dataset.city;
    const existing = btn.querySelector('.badge');
    if(existing) existing.remove();
    const r = cache.get(city);
    const badge = document.createElement('span');
    badge.className='badge';
    if(!r || r.error || typeof r.computedAQI !== 'number'){
      badge.textContent='—'; badge.style.background='#f3f4f6'; badge.style.color='#000';
    } else {
      badge.textContent=String(r.computedAQI); badge.style.background = aqiColor(r.computedAQI); badge.style.color='#fff';
    }
    btn.appendChild(badge);
  }
}

/* load initial buttons */
function buildButtons(){
  cityButtons.innerHTML = '';
  for(const c of CITY_LIST){
    const btn = createCityButton(c);
    cityButtons.appendChild(btn);
  }
}

/* create button factory for map + list */
function createCityButton(city){
  const btn = document.createElement('button');
  btn.className = 'city-btn';
  btn.type = 'button';
  btn.dataset.city = city;
  btn.textContent = city;
  btn.addEventListener('click', async ()=>{
    Array.from(cityButtons.children).forEach(c=>c.classList.remove('active'));
    btn.classList.add('active');
    setStatus(`Loading ${city}...`);
    showSpinner();
    const r = await fetchCityData(city);
    if(r.error){ annotateButtonBadge(btn, r); showCityError(r); return; }
    annotateButtonBadge(btn, r);
    showCity(r);
  });
  return btn;
}

function annotateButtonBadge(btn, r){
  const existing = btn.querySelector('.badge');
  if(existing) existing.remove();
  const badge = document.createElement('span');
  badge.className = 'badge';
  if(!r || r.error || typeof r.computedAQI !== 'number'){
    badge.textContent='—'; badge.style.background='#f3f4f6'; badge.style.color='#000';
  } else {
    badge.textContent=String(r.computedAQI); badge.style.background = aqiColor(r.computedAQI); badge.style.color='#fff';
  }
  btn.appendChild(badge);
}

/* main: fetch all cities, update cache, markers, badges, highlight best */
async function refreshAll(){
  try {
    setStatus('Refreshing all cities...');
    showSpinner();
    const results = await batchFetch(CITY_LIST, FETCH_CONCURRENCY);
    const cache = new Map();
    for(const r of results) {
      cache.set(r.city, r);
    }
    // annotate badges
    annotateAllButtons(cache);
    // identify best city
    let best = null;
    for(const [k,v] of cache.entries()){
      if(!v || v.error || typeof v.computedAQI !== 'number') continue;
      if(!best || v.computedAQI > best.computedAQI) best = v;
      // update marker
      upsertMarker(k, v.computedAQI, `<strong>${k}</strong><br/>AQI: ${v.computedAQI ?? '—'}`);
      saveTrendPoint(k, v.computedAQI);
    }
    if(best){
      // activate best button
      const bestBtn = Array.from(cityButtons.children).find(b=>b.dataset.city===best.city);
      if(bestBtn) { Array.from(cityButtons.children).forEach(c=>c.classList.remove('active')); bestBtn.classList.add('active'); }
      showCity(best);
    } else {
      // fallback to Delhi
      const fallback = cache.get('Delhi') || null;
      if(fallback) showCity(fallback);
    }
    setStatus('Updated all cities');
  } catch(e) {
    console.error('refreshAll err', e);
    setStatus('Failed to refresh');
  } finally {
    hideSpinner();
  }
}

/* filter by category (client side using cached badges) */
function applyCategoryFilter(kind){
  for(const btn of Array.from(cityButtons.children)){
    const city = btn.dataset.city;
    const b = btn.querySelector('.badge');
    const val = b && b.textContent && b.textContent !== '—' ? Number(b.textContent) : null;
    if(kind === 'all'){ btn.style.display = ''; continue; }
    const cat = aqiCategory(val);
    if(kind === 'good' && cat !== 'good') btn.style.display = 'none';
    else if(kind === 'moderate' && cat !== 'moderate') btn.style.display = 'none';
    else if(kind === 'unhealthy' && cat !== 'unhealthy') btn.style.display = 'none';
    else if(kind === 'very' && cat !== 'very') btn.style.display = 'none';
    else if(kind === 'hazardous' && cat !== 'hazardous') btn.style.display = 'none';
    else btn.style.display = '';
  }
}

/* search handler */
async function doSearch(raw){
  const q = (raw || '').trim();
  if(!q) return;
  // if button exists, click it
  const existingButton = Array.from(cityButtons.children).find(b=>b.dataset.city.toLowerCase() === q.toLowerCase());
  if(existingButton){ existingButton.click(); return; }
  // else fetch and add button
  setStatus(`Searching ${q}...`);
  showSpinner();
  const r = await fetchCityData(q);
  if(r.error){ showCityError(r); return; }
  // add button to top
  const nb = createCityButton(r.city);
  cityButtons.prepend(nb);
  annotateButtonBadge(nb, r);
  nb.click();
}

/* dark mode toggle (very simple) */
(function initDarkToggle(){
  const btn = document.getElementById('darkToggle');
  if(!btn) return;
  const darkClass = 'dark-mode';
  const apply = (on)=>{
    if(on){
      document.documentElement.style.background = '#0b1220';
      document.documentElement.style.color = '#e6eef5';
      document.body.style.background = '#071021';
      btn.textContent = 'Light';
      btn.style.background = '#111';
      btn.style.color = '#fff';
    } else {
      document.documentElement.style.background = '';
      document.documentElement.style.color = '';
      document.body.style.background = '';
      btn.textContent = 'Dark';
      btn.style.background = '';
      btn.style.color = '';
    }
  };
  btn.addEventListener('click', ()=> {
    const isDark = btn.textContent === 'Dark';
    apply(isDark);
  });
})();

/* wire controls */
document.getElementById('searchBtn').addEventListener('click', ()=>doSearch(searchBox.value));
searchBox.addEventListener('keydown', (ev)=>{ if(ev.key === 'Enter') doSearch(searchBox.value); });
document.getElementById('refreshBtn').addEventListener('click', ()=>refreshAll());

// category filter
document.getElementById('categoryFilter').addEventListener('change', (ev)=>{
  applyCategoryFilter(ev.target.value);
});

// mobile nav handlers (optional)
const mobileRefresh = document.getElementById('mobileRefresh');
if(mobileRefresh) mobileRefresh.addEventListener('click', ()=>refreshAll());

/* bootstrap */
(async function bootstrap(){
  try {
    buildButtons();
    initMap();
    // initial refresh
    await refreshAll();
    // start auto-refresh
    setInterval(() => { refreshAll(); }, AUTO_REFRESH_MS);
  } catch(e){ console.error('bootstrap err', e); setStatus('Initialization error'); }
})();

/* small helper: create global buildButtons used earlier */
function buildButtons(){
  cityButtons.innerHTML = '';
  for(const c of CITY_LIST){
    const btn = createCityButton(c);
    cityButtons.appendChild(btn);
  }
}
