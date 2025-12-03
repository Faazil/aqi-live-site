// backend/public/script.js (replace existing)
const cityInput = document.getElementById('city');
const fetchBtn = document.getElementById('fetchBtn');
const statusDiv = document.getElementById('status');
const cityName = document.getElementById('city-name');
const aqiValue = document.getElementById('aqi-value');
const aqiDesc = document.getElementById('aqi-desc');
const ctx = document.getElementById('aqiChart') ? document.getElementById('aqiChart').getContext('2d') : null;
let chart = null;

// helpers
function setStatus(text) { statusDiv.textContent = text; console.log('[UI] status:', text); }
function aqiColor(aqi){
  if(aqi===null) return '#6b7280';
  if(aqi<=50) return '#16a34a';
  if(aqi<=100) return '#f59e0b';
  if(aqi<=200) return '#f97316';
  return '#dc2626';
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
function renderChart(measurements){
  if(!ctx) return;
  const labels = measurements.map(m=>m.parameter + (m.unit ? ` (${m.unit})` : ''));
  const values = measurements.map(m=>m.value);
  if(chart) try{ chart.destroy(); } catch(e){ console.warn('chart destroy err', e); }
  chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Latest values', data: values }] },
    options: { responsive:true, plugins:{legend:{display:false}} }
  });
}

// fetch with timeout
function fetchWithTimeout(url, opts = {}, timeout = 10000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
  ]);
}

async function doFetch(city, attempt=1){
  setStatus(`Loading... (attempt ${attempt})`);
  cityName.textContent = city;
  try {
    console.log('[fetch] requesting /api/aqi?city=' + city);
    const res = await fetchWithTimeout(`/api/aqi?city=${encodeURIComponent(city)}`, {}, 10000);
    if(!res.ok) {
      const txt = await res.text().catch(()=>null);
      console.error('[fetch] bad status', res.status, txt);
      setStatus(`Server returned ${res.status}`);
      aqiValue.textContent='—';
      aqiDesc.textContent = txt || 'No data';
      renderChart([]);
      return;
    }
    const data = await res.json();
    console.log('[fetch] data', data);
    const m = data.measurements || [];
    renderChart(m);
    const computed = data.computedAQI ?? computeSimpleAQI(m);

    if(m.length === 0) {
      aqiValue.textContent='—';
      aqiDesc.textContent='No pollutant data returned';
      aqiValue.style.background = '#6b7280';
      setStatus('No measurements returned');
      return;
    }

    if(computed === null){
      aqiValue.textContent = '—';
      aqiDesc.textContent = 'PM2.5/PM10 missing — showing available pollutants';
      aqiValue.style.background = '#6b7280';
    } else {
      aqiValue.textContent = computed;
      aqiDesc.textContent = computed <= 50 ? 'Good' : computed <=100 ? 'Moderate' : computed <=200 ? 'Unhealthy' : 'Very Unhealthy';
      aqiValue.style.background = aqiColor(computed);
    }
    setStatus('Updated');
  } catch (err) {
    console.error('[fetch] error', err);
    if(err.message === 'timeout') setStatus('Request timed out');
    else setStatus('Network error');

    // retry once after short delay
    if(attempt < 2){
      setTimeout(()=> doFetch(city, attempt+1), 5000);
    } else {
      aqiValue.textContent='—';
      aqiDesc.textContent='Unable to fetch AQI data right now.';
      renderChart([]);
    }
  }
}

// attach
fetchBtn && fetchBtn.addEventListener('click', ()=> {
  const city = (cityInput.value || '').trim();
  if(!city) { setStatus('Enter a city'); return; }
  doFetch(city);
});

// auto run on load
window.addEventListener('load', ()=> {
  // if there's a default fetch button, click it
  try { if(fetchBtn) fetchBtn.click(); } catch(e){ console.error(e); }
});
