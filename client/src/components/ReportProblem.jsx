import { useState } from 'react';
import { api } from '../api.js';
import { money, when } from '../format.js';
import { useSession } from '../session.jsx';

// Which reasons make sense depends on who is reporting.
const REASONS_FOR = {
  customer: ['quality', 'no_show', 'overcharged', 'damage', 'conduct', 'other'],
  provider: ['customer', 'conduct', 'other'],
};
const CAN_REPORT = ['arrived', 'in_progress', 'completed'];

/** Shows the job's dispute, or lets the customer / assigned pro raise one. */
export default function ReportProblem({ job, onChange }) {
  const { user, config } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { dispute } = job;

  if (dispute?.status === 'open') {
    return (
      <section className="card dispute open">
        <h3>⚠️ Problem reported</h3>
        <p><strong>{dispute.reasonLabel}</strong>{dispute.details && <> – {dispute.details}</>}</p>
        <p className="muted small">
          Reported {when(dispute.createdAt)}. Our team is looking into it and will contact you both.
          {user.role === 'provider' && ' Your payout for this job is on hold until it is resolved.'}
        </p>
      </section>
    );
  }
  if (dispute?.status === 'resolved') {
    return (
      <section className="card dispute">
        <h3>✅ Problem resolved</h3>
        <p>{dispute.resolutionNote}</p>
        {dispute.refundCents > 0 && <p className="small">Refund to the customer: <strong>{money(dispute.refundCents)}</strong></p>}
        <p className="muted small">Resolved {when(dispute.resolvedAt)}</p>
      </section>
    );
  }
  if (!CAN_REPORT.includes(job.status)) return null;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onChange(await api(`/jobs/${job.id}/disputes`, { method: 'POST', body: { reason, details } }));
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button className="btn link-btn block" onClick={() => setOpen(true)}>Report a problem with this job</button>;
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>Report a problem</h3>
      <p className="muted small">Our team will review it and contact you both. {user.role === 'customer' && 'If you are owed a refund, we will issue it to your card.'}</p>
      <label>
        What went wrong?
        <select required value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Choose one</option>
          {REASONS_FOR[user.role].map((r) => <option key={r} value={r}>{config.disputeReasons[r]}</option>)}
        </select>
      </label>
      <label>
        Tell us more
        <textarea rows={3} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What happened? Include anything that will help us sort it out." />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" className="btn grow" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn primary grow" disabled={busy || !reason}>Send report</button>
      </div>
    </form>
  );
}
