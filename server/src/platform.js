import { badRequest } from './errors.js';

// Business details printed on invoices, editable by admins. Stored as one JSON row in `settings`.
const DEFAULTS = {
  businessName: 'ProNow',
  businessAddress: '',
  registrationNumber: '',
  vatEnabled: false,
  vatRate: 15, // percent; South African standard rate
  vatNumber: '',
  invoiceFooter: 'Thank you for using ProNow.',
};

export function createPlatformSettings({ db }) {
  function get() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'platform'").get();
    return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
  }

  function update(input = {}) {
    const next = { ...get() };
    const text = (key, max) => {
      if (input[key] !== undefined) next[key] = String(input[key] ?? '').trim().slice(0, max);
    };
    text('businessName', 100);
    text('businessAddress', 300);
    text('registrationNumber', 50);
    text('vatNumber', 20);
    text('invoiceFooter', 300);
    if (input.vatEnabled !== undefined) next.vatEnabled = Boolean(input.vatEnabled);
    if (input.vatRate !== undefined) {
      const rate = Number(input.vatRate);
      if (!(rate > 0 && rate < 100)) throw badRequest('VAT rate must be a percentage, e.g. 15');
      next.vatRate = rate;
    }
    if (!next.businessName) throw badRequest('Business name is required');
    // A tax invoice must show the supplier's VAT registration number.
    if (next.vatEnabled && !/^4\d{9}$/.test(next.vatNumber)) {
      throw badRequest('Enter your 10-digit South African VAT number (it starts with 4) before turning VAT on');
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('platform', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  return { get, update };
}
