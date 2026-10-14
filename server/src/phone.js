/**
 * Normalises a phone number to E.164 (+27821234567), which every SMS provider accepts.
 * Local numbers (0821234567) get the default country code. Returns null if it can't be a phone number.
 */
export function toE164(raw, defaultCountryCode = '27') {
  const n = String(raw ?? '').replace(/[\s\-().]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(n)) return n;
  if (/^00[1-9]\d{7,14}$/.test(n)) return `+${n.slice(2)}`;
  if (/^0\d{9}$/.test(n)) return `+${defaultCountryCode}${n.slice(1)}`;
  if (n.startsWith(defaultCountryCode) && /^\d{11,12}$/.test(n)) return `+${n}`;
  return null;
}
