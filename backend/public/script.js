// public/script.js
// Frontend dashboard script (uses /api/aqi/aggregate when available)

const CITY_LIST = [
  'Delhi','Mumbai','Bengaluru','Kolkata','Chennai','Hyderabad','Pune','Ahmedabad',
  'Lucknow','Jaipur','Kanpur','Nagpur','Indore','Bhopal','Patna','Surat',
  'Vadodara','Visakhapatnam','Coimbatore','Ludhiana','Agra','Nashik','Faridabad',
  'Meerut','Rajkot','Kochi','Varanasi','Srinagar','Amritsar','Guwahati'
];

const AUTO_REFRESH_MS = 10 * 60 * 1000;
const FETCH_CONCURRENCY = 4;

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
let markers = {};

function log(...args){ console.info('[aqi]', ...args); }
function setStatus(t){ if(statusText) statusText.textContent = t; log(t); }
function showSpinner(){ if(spinner) spinner.style.display = 'inline-flex'; }
function hideSpinner(){ if(spinner) spinner.style.display = 'none'; }

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

function renderPollutantChips(measurements){
  pollutantBreakdown.innerHTML = '';
  if(!measurements || measurements.length === 0) return;
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

function fetchWithTimeout(url, opts={}, timeout=12000){
  return Promise.race([ fetch(url, opts), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), timeout)) ]);
}

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

/* Map coords for cities (used to place markers) */
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

function initMap(){
  try {
    map = L.map('map', { zoomControl:true }).setView([22.9734,78.6569], 5.2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  } catch(e){ console.warn('leaflet init failed', e); }
}

function upsertMarker(city, aqi, popupHtml){
  if(!map || !CITY_COORDS[city]) return;
  const [lat, lng] = CITY_COORDS[city];
  const color = aqiColor(aqi);
  const icon = L.divIcon({
    html:`<div style="background:${color};color:#fff;padding:6px 8px;border-radius:999px;font-weight:700">${aqi ?? '—'}</div>`,
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
    const lu = data.raw.measurements[0].lastUpdated || (data.raw.time && data.raw.time.s) || null;
    lastUpdated.textContent = lu ? `Updated: ${lu}` : '';
  } else lastUpdated.textContent = '';
  renderPollutantChips(data.measurements);
  renderPollutantChart(data.measurements, data.computedAQI);
  const popup = `<strong>${data.city}</strong><br/>AQI: ${data.computedAQI ?? '—'}<br/>${lastUpdated.textContent || ''}`;
  upsertMarker(data.city, data.computedAQI, popup);
}

function showCityError(r){
  hideSpinner();
  highlightCity.textContent = r.city;
  aqiValue.textContent = '—'; aqiValue.style.background='#6b7280';
  aqiDesc.textContent = `Error: ${r.error || 'unknown'}`;
  lastUpdated.textContent = '';
  pollutantBreakdown.innerHTML = '';
  safeDestroyChart();
}

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

/* Use aggregator snapshot endpoint to populate dashboard in one call */
async function loadAggregateSnapshot(){
  try {
    setStatus('Loading snapshot...');
    showSpinner();
    const resp = await fetchWithTimeout('/api/aqi/aggregate', {}, 12000);
    if (!resp.ok) throw new Error('snapshot not available');
    const json = await resp.json();
    // json.cities is object city -> latest
    const citiesObj = (json && json.cities) ? json.cities : {};
    // build buttons then annotate badges
    cityButtons.innerHTML = '';
    for (const c of CITY_LIST){
      const btn = createCityButton(c);
      cityButtons.appendChild(btn);
      const data = citiesObj[c];
      if (data && !data.error) {
        annotateButtonBadge(btn, data);
        upsertMarker(c, data.computedAQI, `<strong>${c}</strong><br/>AQI: ${data.computedAQI ?? '—'}`);
      } else {
        annotateButtonBadge(btn, null);
      }
    }
    // pick highest from snapshot
    let best = null;
    for (const [k, v] of Object.entries(citiesObj)){
      if (!v || v.error || typeof v.computedAQI !== 'number') continue;
      if (!best || v.computedAQI > best.computedAQI) best = v;
    }
    if (best) {
      const btn = Array.from(cityButtons.children).find(b=>b.dataset.city===best.city);
      if(btn){ Array.from(cityButtons.children).forEach(c=>c.classList.remove('active')); btn.classList.add('active'); }
      showCity(best);
    } else {
      // fallback: show Delhi via individual call
      const fallback = await fetchCityData('Delhi');
      if(!fallback.error) showCity(fallback);
    }
    setStatus('Snapshot loaded');
  } catch (e) {
    console.warn('snapshot load failed', e);
    setStatus('Snapshot not available — falling back to individual fetches');
    // fallback: build buttons and leave them to individual fetch on click
    cityButtons.innerHTML = '';
    for (const c of CITY_LIST) cityButtons.appendChild(createCityButton(c));
  } finally {
    hideSpinner();
  }
}

/* Refresh: use aggregate if available, otherwise per-city */
async function refreshAll(){
  try {
    setStatus('Refreshing all cities...');
    showSpinner();
    const resp = await fetchWithTimeout('/api/aqi/aggregate', {}, 12000).catch(()=>null);
    if (resp && resp.ok){
      const json = await resp.json();
      const citiesObj = (json && json.cities) ? json.cities : {};
      annotateAllButtonsFromSnapshot(citiesObj);
      // update markers
      for (const [k, v] of Object.entries(citiesObj)){
        if(v && !v.error) upsertMarker(k, v.computedAQI, `<strong>${k}</strong><br/>AQI: ${v.computedAQI ?? '—'}`);
      }
      // show best
      let best = null;
      for (const [k, v] of Object.entries(citiesObj)){
        if (!v || v.error || typeof v.computedAQI !== 'number') continue;
        if (!best || v.computedAQI > best.computedAQI) best = v;
      }
      if (best) {
        const btn = Array.from(cityButtons.children).find(b=>b.dataset.city===best.city);
        if(btn){ Array.from(cityButtons.children).forEach(c=>c.classList.remove('active')); btn.classList.add('active'); }
        showCity(best);
      }
      setStatus('Refreshed via snapshot');
      return;
    }
    // fallback: fetch per-city concurrently
    const results = await batchFetch(CITY_LIST, FETCH_CONCURRENCY);
    for (const r of results){
      const btn = Array.from(cityButtons.children).find(b=>b.dataset.city===r.city);
      if(btn) annotateButtonBadge(btn, r);
      if(!r.error) upsertMarker(r.city, r.computedAQI, `<strong>${r.city}</strong><br/>AQI: ${r.computedAQI ?? '—'}`);
    }
    setStatus('Refreshed');
  } catch(e){
    console.error('refreshAll err', e);
    setStatus('Refresh failed');
  } finally {
    hideSpinner();
  }
}

function annotateAllButtonsFromSnapshot(obj){
  for (const btn of Array.from(cityButtons.children)){
    const city = btn.dataset.city;
    const data = obj[city];
    annotateButtonBadge(btn, data);
  }
}

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

/* Search handler */
async function doSearch(q){
  const city = (q || '').trim();
  if(!city) return;
  // if button exists, click it
  const existing = Array.from(cityButtons.children).find(b => b.dataset.city.toLowerCase() === city.toLowerCase());
  if(existing){ existing.click(); return; }
  // else call /api/aqi?city= and add a button
  setStatus(`Searching ${city}...`);
  showSpinner();
  const r = await fetchCityData(city);
  const nb = createCityButton(r.city);
  cityButtons.prepend(nb);
  annotateButtonBadge(nb, r);
  if(!r.error) showCity(r); else showCityError(r);
  hideSpinner();
}

/* event wiring */
searchBtn.addEventListener('click', ()=>doSearch(searchBox.value));
searchBox.addEventListener('keydown', (ev)=>{ if(ev.key === 'Enter') doSearch(searchBox.value); });
refreshBtn.addEventListener('click', ()=>refreshAll());
document.getElementById('categoryFilter').addEventListener('change', (ev)=>{
  const v = ev.target.value;
  applyCategoryFilter(v);
});
document.getElementById('darkToggle').addEventListener('click', ()=>{
  const btn = document.getElementById('darkToggle');
  const isDark = btn.dataset.mode === 'on';
  if(isDark){
    btn.dataset.mode = 'off'; btn.textContent = 'Dark'; document.documentElement.style.background=''; document.body.style.background='';
  } else {
    btn.dataset.mode = 'on'; btn.textContent = 'Light'; document.documentElement.style.background='#071021'; document.body.style.background='#071021';
  }
});

/* filters */
function applyCategoryFilter(kind){
  for(const btn of Array.from(cityButtons.children)){
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

/* bootstrap */
async function init(){
  try {
    initMap();
    await loadAggregateSnapshot();
    setInterval(()=>{ refreshAll(); }, AUTO_REFRESH_MS);
  } catch(e){
    console.error('init err', e);
    setStatus('Initialization failed');
  }
}

init();
