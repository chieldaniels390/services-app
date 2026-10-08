import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { PAYOUT_LABELS, money, when } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

export default function Payouts() {
  const { user, setUser, config } = useSession();
  const account = user.provider.payoutAccount;
  const [editing, setEditing] = useState(!account);
  const [banks, setBanks] = useState([]);
  const [form, setForm] = useState({ bankCode: '', accountNumber: '', accountName: user.name });
  const [payouts, setPayouts] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api('/provider/payouts').then(setPayouts).catch((e) => setError(e.message));
    api('/provider/earnings').then(setEarnings).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useSocketEvent('payouts:updated', refresh);

  useEffect(() => {
    if (editing && !banks.length) api('/provider/banks').then(setBanks).catch((e) => setError(e.message));
  }, [editing, banks.length]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setUser(await api('/provider/payout-account', { method: 'PUT', body: form }));
      setEditing(false);
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError('');
    try {
      setPayouts(await api('/provider/payouts/retry', { method: 'POST' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });
  const retryable = payouts?.some((p) => p.status === 'failed' || (p.status === 'awaiting_details' && account));

  return (
    <div className="payouts">
      <h2>Payouts</h2>
      <p className="muted">
        Customers pay when they book. When you mark a job complete, your share (the job price minus the {Math.round(config.platformFeeRate * 100)}% platform fee)
        is sent to your bank account. Parts are paid out in full once the customer approves them.
      </p>

      {earnings && (
        <section className="stats two">
          <div><span className="muted small">Paid to your bank</span><strong>{money(earnings.paidOutCents)}</strong></div>
          <div><span className="muted small">On the way / waiting</span><strong>{money(earnings.pendingPayoutCents)}</strong></div>
        </section>
      )}

      <section className="card">
        <h3>Bank account</h3>
        {!editing && account && (
          <div className="row">
            <div className="grow">
              <strong>{account.bankName}</strong> ···· {account.last4}
              <div className="muted small">{account.accountName}</div>
            </div>
            <button className="btn" onClick={() => setEditing(true)}>Change</button>
          </div>
        )}
        {editing && (
          <form onSubmit={save}>
            <label>
              Bank
              <select required {...field('bankCode')}>
                <option value="">{banks.length ? 'Choose your bank' : 'Loading banks…'}</option>
                {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
              </select>
            </label>
            <label>Account number<input required inputMode="numeric" autoComplete="off" {...field('accountNumber')} /></label>
            <label>Account holder name<input required {...field('accountName')} /></label>
            <div className="row">
              {account && <button type="button" className="btn grow" onClick={() => setEditing(false)}>Cancel</button>}
              <button className="btn primary grow" disabled={busy}>{busy ? 'Saving…' : 'Save bank account'}</button>
            </div>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <div className="row">
          <h3 className="grow">History</h3>
          {retryable && <button className="btn" disabled={busy} onClick={retry}>Retry failed</button>}
        </div>
        {payouts?.length === 0 && <p className="muted">No payouts yet. Complete a job to get paid.</p>}
        {payouts?.map((p) => (
          <Link key={p.id} to={`/jobs/${p.jobId}`} className="payout-row link-row">
            <span className="icon">{p.categoryIcon}</span>
            <div className="grow">
              <strong>{p.categoryName}{p.kind === 'materials' ? ' · parts' : ''}</strong>
              <div className="muted small">{when(p.paidAt ?? p.createdAt)}</div>
              {p.failureReason && <div className="error small">{p.failureReason}</div>}
            </div>
            <div className="right">
              <strong>{money(p.amountCents)}</strong>
              <span className={`pill payout-${p.status}`}>{PAYOUT_LABELS[p.status]}</span>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
