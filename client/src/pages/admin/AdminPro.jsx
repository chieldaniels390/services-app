import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import DocumentPreview from '../../components/DocumentPreview.jsx';
import { Stars } from '../../components/Stars.jsx';
import { STATUS_LABELS, money, when } from '../../format.js';
import { useSession } from '../../session.jsx';
import { VERIFICATION_LABELS } from './AdminPros.jsx';

const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const hoursSummary = (schedule) => Object.entries(DAY_NAMES)
  .filter(([d]) => schedule[d])
  .map(([d, label]) => `${label} ${schedule[d].start}-${schedule[d].end}`)
  .join(', ') || 'No working days set';

export default function AdminPro({ onChange }) {
  const id = Number(useParams().id);
  const { config, categories } = useSession();
  const [pro, setPro] = useState(null);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/admin/providers/${id}`).then(setPro).catch((e) => setError(e.message));
  }, [id]);

  async function decide(decision) {
    if (decision === 'approve' && pro.verification.status === 'rejected'
      && !window.confirm('This pro was rejected before. Approve them now?')) return;
    setBusy(true);
    setError('');
    try {
      setPro(await api(`/admin/providers/${id}/verification`, { method: 'POST', body: { decision, note } }));
      setRejecting(false);
      setNote('');
      onChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function decideTrades(decision) {
    setBusy(true);
    setError('');
    try {
      setPro(await api(`/admin/providers/${id}/trades`, { method: 'POST', body: { decision } }));
      onChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!pro) return <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>;
  const v = pro.verification;
  return (
    <div className="admin-page">
      <Link to="/admin/pros" className="back-link">‹ Pros</Link>
      <section className="card pro-head">
        <div className="avatar lg">{pro.name[0]}</div>
        <div className="grow">
          <h2>{pro.name} <span className={`pill verify-${v.status}`}>{VERIFICATION_LABELS[v.status]}</span></h2>
          <p className="muted small">{pro.email} · {pro.phone ?? 'no phone'} · joined {when(pro.createdAt)}</p>
          <p className="small">
            {pro.categories.map((c) => {
              const cat = categories.find((x) => x.id === c);
              return <span key={c} className={`trade ${pro.pendingCategories.includes(c) ? 'pending' : ''}`}>{cat?.icon} {cat?.name}</span>;
            })}
          </p>
          <p className="muted small">
            {pro.serviceArea ? `Works within ${pro.serviceArea.radiusKm} km of a chosen centre` : 'Works around their live location (default radius)'}
            {' · '}{pro.workingHours ? hoursSummary(pro.workingHours) : 'Any time'}
          </p>
          {pro.bio && <p className="muted">“{pro.bio}”</p>}
          {v.status === 'approved' && <Stars value={pro.rating} count={pro.ratingCount} />}
        </div>
      </section>

      {v.status === 'approved' && pro.pendingCategories.length > 0 && (
        <section className="card highlight">
          <h3>New trades to approve</h3>
          <p>
            {pro.name} added{' '}
            <strong>{pro.pendingCategories.map((c) => categories.find((x) => x.id === c)?.name).join(', ')}</strong>.
            Check their certificate below covers {pro.pendingCategories.length > 1 ? 'these trades' : 'this trade'} before approving.
          </p>
          <div className="row">
            <button className="btn primary grow" disabled={busy} onClick={() => decideTrades('approve')}>Approve new trades</button>
            <button className="btn danger grow" disabled={busy} onClick={() => decideTrades('reject')}>Reject</button>
          </div>
        </section>
      )}

      <section className="card">
        <h3>Documents</h3>
        {v.documents.length === 0 && <p className="muted">Nothing uploaded yet.</p>}
        <div className="doc-grid">
          {Object.entries(config.documentKinds).map(([kind, label]) => {
            const doc = v.documents.find((d) => d.kind === kind);
            return (
              <figure key={kind}>
                {doc ? <DocumentPreview doc={doc} label={label} large /> : <div className="doc-missing">Missing</div>}
                <figcaption><strong>{label}</strong>{doc && <span className="muted small"> · {when(doc.createdAt)}</span>}</figcaption>
              </figure>
            );
          })}
        </div>
        <p className="hint">Check the selfie matches the ID photo, the names match ({pro.name}), and the certificate covers the services they offer.</p>

        {v.note && <p className={v.status === 'rejected' ? 'reject-note' : 'muted'}><strong>Last note:</strong> {v.note}</p>}
        {error && <p className="error">{error}</p>}
        {!rejecting ? (
          <div className="row decision">
            {v.status !== 'approved' && (
              <button className="btn primary grow" disabled={busy || v.missing.length > 0} onClick={() => decide('approve')}>
                ✓ Approve
              </button>
            )}
            <button className="btn danger grow" disabled={busy} onClick={() => setRejecting(true)}>
              {v.status === 'approved' ? 'Suspend' : '✕ Reject'}
            </button>
          </div>
        ) : (
          <div className="reject-form">
            <label>
              {v.status === 'approved' ? 'Why are you suspending this pro?' : 'What does the pro need to fix?'} (they will see this)
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The ID photo is blurry - please upload a clearer one." />
            </label>
            <div className="row">
              <button className="btn grow" onClick={() => setRejecting(false)}>Cancel</button>
              <button className="btn danger grow" disabled={busy || !note.trim()} onClick={() => decide('reject')}>
                {v.status === 'approved' ? 'Suspend pro' : 'Reject'}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Payout account</h3>
        {pro.payoutAccount ? <p>{pro.payoutAccount.bankName} ···· {pro.payoutAccount.last4} · {pro.payoutAccount.accountName}</p> : <p className="muted">Not added yet.</p>}
      </section>

      <section className="card">
        <h3>Recent jobs</h3>
        {pro.recentJobs.length === 0 && <p className="muted">No jobs yet.</p>}
        {pro.recentJobs.map((j) => (
          <Link key={j.id} to={`/admin/jobs/${j.id}`} className="todo-row">
            <span className="icon">{j.category.icon}</span>
            <span className="grow">#{j.id} · {j.customerName} · {when(j.createdAt)}</span>
            <span>{money(j.finalCents ?? j.estimatedCents)}</span>
            <span className={`pill status-${j.status}`}>{STATUS_LABELS[j.status]}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
