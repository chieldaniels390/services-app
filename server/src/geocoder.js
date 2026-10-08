import { HttpError } from './errors.js';

const MIN_INTERVAL_MS = 1100; // Nominatim allows at most one request per second.
const CACHE_SIZE = 500;

/** Address search and reverse lookup against a Nominatim-compatible API, throttled and cached. */
export function createGeocoder({ url, userAgent, countryCodes }) {
  const cache = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  // Requests run one at a time, spaced at least MIN_INTERVAL_MS apart.
  function throttled(fn) {
    const run = queue.then(async () => {
      const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function request(path, params) {
    const key = `${path}?${new URLSearchParams(params)}`;
    if (cache.has(key)) return cache.get(key);
    const data = await throttled(async () => {
      const res = await fetch(`${url}${key}`, {
        headers: { 'user-agent': userAgent, 'accept-language': 'en' },
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (!res?.ok) throw new HttpError(502, 'Address search is unavailable right now - drop the pin on the map instead');
      return res.json();
    });
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, data);
    return data;
  }

  return {
    async search(query) {
      const results = await request('/search', {
        q: query, format: 'jsonv2', addressdetails: '1', limit: '5',
        ...(countryCodes && { countrycodes: countryCodes }),
      });
      return results.map((r) => ({ label: labelFor(r), lat: Number(r.lat), lng: Number(r.lon) }));
    },
    async reverse(lat, lng) {
      const result = await request('/reverse', { lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1', zoom: '18' });
      return result?.error ? null : { label: labelFor(result), lat, lng };
    },
  };
}

/** "12 Main Road, Sea Point, Cape Town" rather than Nominatim's long display name. */
function labelFor(r) {
  const a = r.address ?? {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const area = a.suburb ?? a.neighbourhood ?? a.quarter;
  const city = a.city ?? a.town ?? a.village ?? a.municipality;
  const parts = [r.name !== a.road ? r.name : null, street, area, city].filter(Boolean);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  return unique.length ? unique.join(', ') : r.display_name;
}
