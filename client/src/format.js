let moneyFormat = { currency: 'ZAR', locale: 'en-ZA' };

/** Called once the server config arrives so all prices use the marketplace's currency and locale. */
export function setMoneyFormat({ currency, locale }) {
  moneyFormat = { currency, locale };
}

/** R1 250 for whole amounts, R1 250,50 otherwise. */
export function money(cents) {
  if (cents == null) return '–';
  const digits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(moneyFormat.locale, {
    style: 'currency', currency: moneyFormat.currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(cents / 100);
}

export const currencySymbol = () =>
  new Intl.NumberFormat(moneyFormat.locale, { style: 'currency', currency: moneyFormat.currency })
    .formatToParts(0).find((p) => p.type === 'currency')?.value ?? moneyFormat.currency;

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

// Jobs happen in the marketplace's time zone, so every date and time is shown (and entered) in it,
// whatever time zone the viewer's device is set to.
let timeZone = 'Africa/Johannesburg';
export const setTimeZone = (tz) => { timeZone = tz; };

export function when(value) {
  if (!value) return '';
  return parse(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });
}

export function timeOnly(value) {
  if (!value) return '';
  return parse(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone });
}

/** A datetime-local value ("2026-10-19T09:00") read as wall-clock time in the marketplace time zone, as ISO UTC. */
export function zonedInputToIso(value) {
  const [date, time] = value.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess)).map(({ type, value: v }) => [type, Number(v)]));
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(guess).toISOString();
}

export const STATUS_LABELS = {
  awaiting_payment: 'Awaiting payment',
  requested: 'Finding a pro',
  accepted: 'Pro assigned',
  en_route: 'On the way',
  arrived: 'Arrived',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const ACTIVE_STATUSES = ['awaiting_payment', 'requested', 'accepted', 'en_route', 'arrived', 'in_progress'];

export const PAYOUT_LABELS = {
  awaiting_details: 'Waiting for your bank details',
  sending: 'Sending…',
  processing: 'On its way to your bank',
  paid: 'Paid to your bank',
  failed: 'Failed',
  on_hold: 'On hold (dispute)',
  cancelled: 'Cancelled',
};

/** Paystack's hosted checkout; it sends the customer back to the job page when they're done. */
export const goToCheckout = (url) => window.location.assign(url);

/** "just now", "5 min ago", "3 h ago", then a date. */
export function ago(value) {
  if (!value) return '';
  const seconds = (Date.now() - parse(value).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return parse(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone });
}
