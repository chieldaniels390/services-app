import { useEffect, useState } from 'react';
import { api } from '../../api.js';

export default function AdminSettings() {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/admin/settings').then((s) => { setForm(s); setSaved(s); }).catch((e) => setError(e.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await api('/admin/settings', { method: 'PUT', body: form });
      setForm(next);
      setSaved(next);
      setMessage('Saved. New invoices use these details; invoices already issued stay as they are.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!form) return <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>;
  const field = (key) => ({ value: form[key] ?? '', onChange: (e) => setForm({ ...form, [key]: e.target.value }) });
  const changed = JSON.stringify(form) !== JSON.stringify(saved);

  return (
    <form className="admin-page settings-form" onSubmit={save}>
      <h2>Settings</h2>
      <section className="card">
        <h3>Invoice details</h3>
        <p className="muted small">Printed at the top of every customer invoice.</p>
        <label>Business name<input required maxLength={100} {...field('businessName')} /></label>
        <label>Business address<textarea rows={2} maxLength={300} {...field('businessAddress')} /></label>
        <label>Company registration number <span className="muted">(optional)</span><input maxLength={50} {...field('registrationNumber')} /></label>
        <label>Invoice footer<input maxLength={300} {...field('invoiceFooter')} /></label>
      </section>

      <section className="card">
        <div className="setting">
          <div className="grow">
            <strong>VAT on invoices</strong>
            <p className="muted small">
              When on, invoices become <strong>tax invoices</strong>: they show your VAT number and the VAT included in the price.
              Prices don't change, because customer prices already include VAT.
            </p>
          </div>
          <button type="button" className={`toggle ${form.vatEnabled ? 'on' : ''}`} aria-pressed={form.vatEnabled} aria-label="VAT on invoices" onClick={() => setForm({ ...form, vatEnabled: !form.vatEnabled })}>
            <span />
          </button>
        </div>
        <div className="row wrap">
          <label className="grow">VAT number<input inputMode="numeric" placeholder="4xxxxxxxxx" maxLength={10} {...field('vatNumber')} /></label>
          <label>VAT rate (%)<input type="number" min="1" max="99" step="0.5" {...field('vatRate')} /></label>
        </div>
        <p className="hint">Switching VAT on or off only affects invoices issued from now on. Check with your accountant when to register for VAT.</p>
      </section>

      {error && <p className="error">{error}</p>}
      {message && <p className="notice">{message}</p>}
      <button className="btn primary lg" disabled={busy || !changed}>{busy ? 'Saving…' : 'Save settings'}</button>
    </form>
  );
}
