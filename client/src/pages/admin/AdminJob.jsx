import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadFile } from '../../api.js';
import { PAYOUT_LABELS, STATUS_LABELS, money, timeOnly, when } from '../../format.js';
import { useSession, useSocketEvent } from '../../session.jsx';

const PAYMENT_LABELS = { pending: 'Not paid', paid: 'Paid', refund_pending: 'Refund pending', refunded: 'Refunded', failed: 'Failed', refund_failed: 'Refund failed' };
// Same states as the pro sees, worded for an admin.
const ADMIN_PAYOUT_LABELS = { ...PAYOUT_LABELS, awaiting_details: "Waiting for pro's bank details", processing: 'Transfer in progress', paid: 'Paid to pro' };
const toCents = (rands) => Math.round(Number(String(rands).replace(',', '.')) * 100);

function RefundForm({ jobId, refundableCents, onDone }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    const cents = toCents(amount);
    if (!window.confirm(`Refund ${money(cents)} to the customer's card? This can't be undone.`)) return;
    setBusy(true);
    setError('');
    try {
      onDone(await api(`/admin/jobs/${jobId}/refunds`, { method: 'POST', body: { amountCents: cents, reason } }));
      setAmount('');
      setReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Issue a refund</h3>
      <p className="muted small">Up to {money(refundableCents)} can be refunded. This doesn't change the pro's payout; to hold or cancel that, use a dispute.</p>
      <div className="row wrap">
        <label className="grow">Amount (R)
          <input required inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button type="button" className="btn" onClick={() => setAmount((refundableCents / 100).toFixed(2))}>Full amount</button>
      </div>
      <label>Reason (internal)
        <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Pro arrived 2 hours late" />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn danger block" disabled={busy || !(toCents(amount) > 0)}>Refund {amount && toCents(amount) > 0 ? money(toCents(amount)) : ''}</button>
    </form>
  );
}

function ResolveForm({ dispute, refundableCents, heldCents, onDone }) {
  const [refund, setRefund] = useState('0');
  const [payoutAction, setPayoutAction] = useState('release');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    const refundCents = toCents(refund || 0);
    const summary = [
      refundCents > 0 ? `refund ${money(refundCents)} to the customer` : 'no refund',
      heldCents > 0 ? `${payoutAction === 'release' ? 'pay' : 'cancel'} the held ${money(heldCents)} payout` : null,
    ].filter(Boolean).join(' and ');
    if (!window.confirm(`Resolve this dispute: ${summary}?`)) return;
    setBusy(true);
    setError('');
    try {
      onDone(await api(`/admin/disputes/${dispute.id}/resolve`, { method: 'POST', body: { refundCents, payoutAction, note } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="resolve-form">
      <label>Refund to customer (R, max {money(refundableCents)})
        <input inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} />
      </label>
      <fieldset>
        <legend>Pro's payout {heldCents > 0 ? `(${money(heldCents)} on hold)` : '(nothing on hold)'}</legend>
        <label className="radio"><input type="radio" checked={payoutAction === 'release'} onChange={() => setPayoutAction('release')} /> Release it to the pro</label>
        <label className="radio"><input type="radio" checked={payoutAction === 'cancel'} onChange={() => setPayoutAction('cancel')} /> Cancel it (platform keeps the money)</label>
        {heldCents === 0 && <p className="hint">The payout was already sent or the job isn't complete yet, so this choice only applies to future payouts held by this dispute.</p>}
      </fieldset>
      <label>Outcome (both the customer and the pro will see this)
        <textarea required rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Pro agreed to return; partial refund for the delay." />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn primary block" disabled={busy || !note.trim()}>Resolve dispute</button>
    </form>
  );
}

function FlagForm({ jobId, onDone }) {
  const { config } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState('');
  if (!open) return <button className="btn block" onClick={() => setOpen(true)}>Open a dispute on this job</button>;
  async function submit(e) {
    e.preventDefault();
    try {
      onDone(await api(`/admin/jobs/${jobId}/disputes`, { method: 'POST', body: { reason, details } }));
      setOpen(false);
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Open a dispute</h3>
      <p className="muted small">Holds any payout that hasn't been sent yet until you resolve it.</p>
      <label>Reason
        <select required value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Choose one</option>
          {Object.entries(config.disputeReasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>Details<textarea rows={2} value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <div className="row"><button type="button" className="btn grow" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary grow" disabled={!reason}>Open dispute</button></div>
    </form>
  );
}

function RatingBadge({ person }) {
  if (!person.ratingCount) return <span className="muted small">no ratings</span>;
  return (
    <>
      <span className="stars small">★ {person.rating}</span> <span className="muted small">({person.ratingCount})</span>
      {person.flagged && <span className="pill flag-pill">Low rating</span>}
    </>
  );
}

export default function AdminJob({ onChange }) {
  const id = Number(useParams().id);
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api(`/admin/jobs/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useSocketEvent('admin:updated', (e) => e.jobId === id && load());

  if (!d) return <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>;
  const { job } = d;
  const update = (next) => { setD(next); onChange(); };
  const openDispute = d.disputes.find((x) => x.status === 'open');
  const heldCents = d.payouts.filter((p) => p.status === 'on_hold').reduce((s, p) => s + p.amountCents, 0);
  const timeline = [
    ['Booked', job.createdAt], ['Accepted', job.acceptedAt], ['Work started', job.startedAt],
    ['Completed', job.completedAt], ['Cancelled', job.cancelledAt],
  ].filter(([, t]) => t);

  return (
    <div className="admin-page admin-job">
      <Link to="/admin/jobs" className="back-link">‹ Jobs</Link>
      <section className="card">
        <div className="row wrap">
          <h2 className="grow">{job.category.icon} Job #{job.id} · {job.category.name}</h2>
          <span className={`pill status-${job.status}`}>{STATUS_LABELS[job.status]}</span>
          {openDispute && <span className="pill dispute-pill">Disputed</span>}
          {job.hasInvoice && (
            <button className="btn" onClick={() => api(`/jobs/${job.id}/invoice`)
              .then((inv) => downloadFile(`/jobs/${job.id}/invoice.pdf`, `${inv.number}.pdf`))
              .catch((e) => setError(e.message))}
            >
              ⬇ Invoice
            </button>
          )}
        </div>
        <p>{job.description}</p>
        <p className="muted small">📍 {job.address} · {job.sizeLabel}{job.scheduledFor && ` · scheduled ${when(job.scheduledFor)}`}</p>
        <p className="muted small">{timeline.map(([label, t]) => `${label} ${when(t)}`).join(' → ')}</p>
      </section>

      <div className="admin-columns">
        <div>
          <section className="card">
            <h3>People</h3>
            <dl className="kv">
              <dt>Customer</dt>
              <dd>
                {d.customer.name} <RatingBadge person={d.customer} />
                <br /><span className="muted small">{d.customer.email} · {d.customer.phone ?? 'no phone'}</span>
              </dd>
              <dt>Pro</dt>
              <dd>
                {d.provider ? (
                  <><Link to={`/admin/pros/${d.provider.id}`}>{d.provider.name}</Link> <RatingBadge person={d.provider} /><br /><span className="muted small">{d.provider.email} · {d.provider.phone ?? 'no phone'}</span></>
                ) : <span className="muted">Not assigned</span>}
              </dd>
            </dl>
          </section>

          <section className="card">
            <h3>Money</h3>
            <dl className="kv">
              <dt>Upfront price</dt><dd>{money(job.estimatedCents)}{job.surge > 1 && <span className="surge"> ×{job.surge}</span>}</dd>
              {job.materialsCents > 0 && <><dt>Parts</dt><dd>{money(job.materialsCents)}</dd></>}
              {job.platformFeeCents != null && <><dt>Platform fee</dt><dd>{money(job.platformFeeCents)} ({Math.round((job.feeRate ?? 0) * 100)}%)</dd></>}
              {job.payoutCents != null && <><dt>Pro earns</dt><dd>{money(job.payoutCents)}</dd></>}
              <dt>Refunded</dt><dd>{money(job.refundedCents)}</dd>
            </dl>
            <h4>Payments</h4>
            {d.payments.length === 0 && <p className="muted small">None.</p>}
            {d.payments.map((p) => (
              <div key={p.id} className="money-row">
                <span className="grow">{p.kind === 'booking' ? 'Booking' : 'Parts'} · <code>{p.reference}</code></span>
                <span>{money(p.amountCents)}{p.refundedCents > 0 && <span className="muted small"> (−{money(p.refundedCents)})</span>}</span>
                <span className={`pill pay-${p.status}`}>{PAYMENT_LABELS[p.status] ?? p.status}</span>
              </div>
            ))}
            <h4>Payouts to pro</h4>
            {d.payouts.length === 0 && <p className="muted small">None yet.</p>}
            {d.payouts.map((p) => (
              <div key={p.id} className="money-row">
                <span className="grow">{p.kind === 'labour' ? 'Job' : 'Parts'}{p.failureReason && <span className="error small"> · {p.failureReason}</span>}</span>
                <span>{money(p.amountCents)}</span>
                <span className={`pill payout-${p.status}`}>{ADMIN_PAYOUT_LABELS[p.status]}</span>
              </div>
            ))}
            {d.refunds.length > 0 && <h4>Refunds</h4>}
            {d.refunds.map((r) => (
              <div key={r.id} className="money-row">
                <span className="grow">{r.reason}<br /><span className="muted small">{r.createdBy ?? 'Automatic'} · {when(r.createdAt)}</span></span>
                <span>{money(r.amountCents)}</span>
                <span className="pill">{r.status === 'processed' ? 'Processed' : 'Pending'}</span>
              </div>
            ))}
          </section>
          {d.refundableCents > 0 && <RefundForm jobId={id} refundableCents={d.refundableCents} onDone={update} />}
        </div>

        <div>
          <section className="card">
            <h3>Disputes</h3>
            {d.disputes.length === 0 && <p className="muted small">No disputes on this job.</p>}
            {d.disputes.map((x) => (
              <div key={x.id} className={`dispute-block ${x.status}`}>
                <p><strong>{x.reasonLabel}</strong> <span className={`pill ${x.status === 'open' ? 'dispute-pill' : ''}`}>{x.status === 'open' ? 'Open' : 'Resolved'}</span></p>
                {x.details && <p>{x.details}</p>}
                <p className="muted small">Raised by {x.openedByName} ({x.openedByRole === 'provider' ? 'pro' : x.openedByRole}) · {when(x.createdAt)}</p>
                {x.status === 'resolved' ? (
                  <p className="small">
                    <strong>Outcome:</strong> {x.resolutionNote}<br />
                    Refund {money(x.refundCents)} · payout {x.payoutAction === 'cancel' ? 'cancelled' : 'released'} · by {x.resolvedByName} {when(x.resolvedAt)}
                  </p>
                ) : (
                  <ResolveForm dispute={x} refundableCents={d.refundableCents} heldCents={heldCents} onDone={update} />
                )}
              </div>
            ))}
            {!openDispute && <FlagForm jobId={id} onDone={update} />}
          </section>

          {d.jobReviews.length > 0 && (
            <section className="card">
              <h3>Ratings on this job</h3>
              {d.jobReviews.map((r) => (
                <p key={r.reviewerRole}>
                  <span className="muted small">{r.reviewerRole === 'customer' ? 'Customer → pro' : 'Pro → customer'}</span><br />
                  <span className="stars">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span> {r.comment}
                </p>
              ))}
            </section>
          )}

          <section className="card">
            <h3>Text messages sent</h3>
            {d.sms.length === 0 && <p className="muted small">None for this job.</p>}
            {d.sms.map((s) => (
              <div key={s.id} className="money-row">
                <span className="grow">
                  {s.body}
                  <br /><span className="muted small">To {s.userName} ({s.toNumber}) via {s.provider} · {when(s.createdAt)}</span>
                  {s.error && <><br /><span className="error small">{s.error}</span></>}
                </span>
                <span className={`pill ${s.status === 'sent' ? 'pay-paid' : s.status === 'failed' ? 'payout-failed' : ''}`}>{s.status}</span>
              </div>
            ))}
          </section>

          <section className="card">
            <h3>Messages</h3>
            {d.messages.length === 0 && <p className="muted small">No messages.</p>}
            <div className="message-log">
              {d.messages.map((m) => (
                <p key={m.id}><strong>{m.senderName}</strong> <span className="muted small">{timeOnly(m.createdAt)}</span><br />{m.body}</p>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
