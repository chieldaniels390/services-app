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

export function when(value) {
  if (!value) return '';
  return parse(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeOnly(value) {
  if (!value) return '';
  return parse(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
};

/** Paystack's hosted checkout; it sends the customer back to the job page when they're done. */
export const goToCheckout = (url) => window.location.assign(url);
