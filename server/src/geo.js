const EARTH_RADIUS_KM = 6371;
const AVERAGE_SPEED_KMH = 30; // urban driving

const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export const etaMinutes = (km) => Math.max(2, Math.round((km / AVERAGE_SPEED_KMH) * 60));

export const isValidPoint = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
