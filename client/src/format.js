export function money(cents, currency = 'USD') {
  if (cents == null) return '–';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

export function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const etaMinutes = (km) => Math.max(1, Math.round((km / 30) * 60));

// SQLite datetime('now') is UTC without a zone marker.
const parse = (value) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);

export function when(value) {
  if (!value) return '';
  return parse(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeOnly(value) {
  if (!value) return '';
  return parse(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const STATUS_LABELS = {
  requested: 'Finding a pro',
  accepted: 'Pro assigned',
  en_route: 'On the way',
  arrived: 'Arrived',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const ACTIVE_STATUSES = ['requested', 'accepted', 'en_route', 'arrived', 'in_progress'];
