// frontend script: flexible with returned pollutants
const aqiValue = document.getElementById('aqi-value');
const aqiDesc = document.getElementById('aqi-desc');
const cityName = document.getElementById('city-name');
const statusDiv = document.getElementById('status');
const ctx = document.getElementById('aqiChart').getContext('2d');
let chart;

function setStatus(t){ statusDiv.textContent = t; }

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
  const labels = measurements.map(m=>m.parameter + (m.unit ? ` (${m.unit})` : ''));
  const values = measurements.map(m=>m.value);
  if(chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Latest values', data: values }] },
    options: { responsive:true, plugins:{legend:{display:false}} }
  });
}

document.getElementById('fetchBtn').addEventListener('click', async ()=>{
  const city = document.getElementById('city').value.trim();
  if(!city) return setStatus('Enter a city');
  setStatus('Loading...');
  try{
    const res = await fetch(`/api/aqi?city=${encodeURIComponent(city)}`);
    setStatus(`HTTP ${res.status}`);
    if(!res.ok) {
      const txt = await res.text().catch(()=>null);
      setStatus('Unable to extract AQI data');
      cityName.textContent = city;
      aqiValue.textContent = '—';
      aqiValue.style.background = '#9CA3AF';
      aqiDesc.textContent = txt || 'No data';
      return;
    }
    const data = await res.json();
    cityName.textContent = data.city || city;
    const m = data.measurements || [];
    if(m.length===0){
      aqiValue.textContent='—';
      aqiDesc.textContent='AQI data unavailable for the selected city. Please check back later.';
      aqiValue.style.background = '#9CA3AF';
      renderChart([]);
      return;
    }
    renderChart(m);
    const aqi = data.computedAQI ?? computeSimpleAQI(m);
    if(aqi===null){
      aqiValue.textContent='—';
      aqiDesc.textContent='PM2.5/PM10 not available — showing available pollutants';
      aqiValue.style.background = '#9CA3AF';
    } else {
      aqiValue.textContent = aqi;
      const color = aqiColor(aqi);
      aqiValue.style.background = color;
      aqiDesc.textContent = aqi<=50? 'Good' : aqi<=100? 'Moderate' : aqi<=200? 'Unhealthy' : 'Very Unhealthy';
    }
    setStatus('Updated');
  }catch(e){
    console.error(e);
    setStatus('Network / server error');
  }
});

// auto-fetch default
window.addEventListener('load', ()=>document.getElementById('fetchBtn').click());
