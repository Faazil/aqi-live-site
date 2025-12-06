// aggregator/aqi-aggregator.js
// Simple in-memory aggregator for AQI data
// Usage: require and start the aggregator in your main server boot script.
//
// Configuration via env:
// AGG_POLL_INTERVAL_MS (default 5 minutes) -> how often aggregator polls upstream
// AGG_KEEP_MS (default 24h) -> how long to keep points
// AGG_CITIES -> optional comma-separated list of cities (fallback to built-in list)

const fetch = globalThis.fetch || require('node-fetch');
const DEFAULT_INTERVAL = Number(process.env.AGG_POLL_INTERVAL_MS) || 5 * 60 * 1000;
const KEEP_MS = Number(process.env.AGG_KEEP_MS) || 24 * 60 * 60 * 1000;

const DEFAULT_CITIES = (process.env.AGG_CITIES && process.env.AGG_CITIES.split(',')) || [
  'Delhi','Mumbai','Bengaluru','Kolkata','Chennai','Hyderabad','Pune','Ahmedabad',
  'Lucknow','Jaipur','Kanpur','Nagpur','Indore','Bhopal','Patna','Surat',
  'Vadodara','Visakhapatnam','Coimbatore','Ludhiana','Agra','Nashik','Faridabad',
  'Meerut','Rajkot','Kochi','Varanasi','Srinagar','Amritsar','Guwahati'
];

class Aggregator {
  constructor({ pollInterval = DEFAULT_INTERVAL, cities = DEFAULT_CITIES, upstreamBase = '' } = {}) {
    this.pollInterval = pollInterval;
    this.cities = cities;
    this.upstreamBase = upstreamBase || ''; // use same host when aggregator runs with server; e.g. '' means relative
    this.store = new Map(); // city -> { latest: {...}, history: [ { t, computedAQI, measurements } ] }
    this.timer = null;
    this.running = false;
  }

  // Add or update a city sample
  _pushSample(city, sample) {
    const now = Date.now();
    if (!this.store.has(city)) this.store.set(city, { latest: null, history: [] });
    const entry = this.store.get(city);
    entry.latest = { ...sample, t: now };
    entry.history.push({ t: now, computedAQI: sample.computedAQI ?? null, measurements: sample.measurements ?? [] });

    // prune old points
    const cutoff = now - KEEP_MS;
    entry.history = entry.history.filter(p => p.t >= cutoff);
  }

  // fetch from upstream endpoint - expects same shape as your /api/aqi?city=...
  async _fetchUpstream(city) {
    // note: this assumes aggregator is running on same origin as frontend backend;
    // if upstream is external, set process.env.AGG_UPSTREAM_BASE to that absolute URL (no trailing slash)
    const base = process.env.AGG_UPSTREAM_BASE || this.upstreamBase || '';
    const url = `${base}/api/aqi?city=${encodeURIComponent(city)}`;
    try {
      const res = await fetch(url, { timeout: 12000 });
      if (!res.ok) {
        const txt = await res.text().catch(()=>null);
        throw new Error(`upstream ${res.status} ${txt ? txt.slice(0,200):''}`);
      }
      const json = await res.json();
      // normalize: computedAQI fallback to computed or null
      const computed = (typeof json.computedAQI === 'number') ? json.computedAQI : null;
      const measurements = Array.isArray(json.measurements) ? json.measurements : [];
      return { city, computedAQI: computed, measurements, raw: json };
    } catch (err) {
      return { city, error: String(err) };
    }
  }

  // Poll all cities (concurrency-limited)
  async pollAll(concurrency = 6) {
    const cities = this.cities;
    let idx = 0;
    const workers = new Array(Math.min(concurrency, cities.length)).fill().map(async ()=> {
      while (idx < cities.length) {
        const i = idx++;
        const c = cities[i];
        try {
          const r = await this._fetchUpstream(c);
          if (!r.error) this._pushSample(c, r);
          else console.warn('[aggregator] fetch error for', c, r.error);
        } catch (e) { console.error('[aggregator] poll error', e); }
      }
    });
    await Promise.all(workers);
  }

  // start periodic polling
  start() {
    if (this.running) return;
    this.running = true;
    console.info(`[aggregator] start polling every ${this.pollInterval}ms for ${this.cities.length} cities`);
    // first-run now
    this.pollAll().catch(e=>console.error('[aggregator] first poll failed', e));
    this.timer = setInterval(()=> this.pollAll().catch(e=>console.error('[aggregator] pollAll failed', e)), this.pollInterval);
  }

  stop() {
    if (!this.running) return;
    clearInterval(this.timer);
    this.running = false;
    console.info('[aggregator] stopped');
  }

  // public methods to read cache
  getLatest(city) {
    const entry = this.store.get(city);
    if (!entry) return null;
    return entry.latest;
  }
  getHistory(city) {
    const entry = this.store.get(city);
    if (!entry) return [];
    return entry.history.slice();
  }
  getAllLatest() {
    const out = {};
    for (const city of this.cities) {
      out[city] = this.getLatest(city);
    }
    return out;
  }
}

module.exports = { Aggregator };
