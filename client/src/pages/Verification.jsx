import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiUpload } from '../api.js';
import DocumentPreview from '../components/DocumentPreview.jsx';
import { when } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

const SLOTS = {
  id: { hint: 'Green ID book, smart ID card (both sides in one photo) or passport.', accept: 'image/*,application/pdf' },
  certificate: { hint: 'Trade test certificate, wireman’s licence, PIRB card or similar for your trade.', accept: 'image/*,application/pdf' },
  selfie: { hint: 'A clear photo of your face, no sunglasses or hat. We compare it to your ID.', accept: 'image/*', capture: 'user' },
};

const STATUS = {
  unsubmitted: { title: 'Get verified to start earning', body: 'Upload the three documents below, then submit them for review.' },
  pending: { title: 'Your documents are being reviewed', body: 'We usually review new pros within one business day. We’ll let you know here as soon as you’re approved.' },
  rejected: { title: 'We couldn’t approve your account yet', body: 'Please fix the issue below, re-upload the document and submit again.' },
  approved: { title: 'You’re verified ✓', body: 'Customers see a verified badge on your profile. You can go online and take jobs.' },
};

export default function Verification() {
  const { config, setUser } = useSession();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => api('/provider/verification').then(setState).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useSocketEvent('verification:updated', (s) => {
    setState(s);
    api('/me').then(setUser).catch(() => {});
  });

  async function choose(kind, file) {
    if (!file) return;
    setBusy(kind);
    setError('');
    try {
      setState(await apiUpload(`/provider/documents/${kind}`, file));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function submit() {
    setBusy('submit');
    setError('');
    try {
      setState(await api('/provider/verification/submit', { method: 'POST' }));
      setUser(await api('/me'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  if (!state) return <p className="muted">{error || 'Loading…'}</p>;
  const editable = state.status === 'unsubmitted' || state.status === 'rejected';
  const copy = STATUS[state.status];

  return (
    <div className="verification">
      <section className={`card verify-status verify-${state.status}`}>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        {state.status === 'rejected' && state.note && <p className="reject-note"><strong>Reason:</strong> {state.note}</p>}
        {state.status === 'pending' && state.submittedAt && <p className="muted small">Submitted {when(state.submittedAt)}</p>}
        {state.status === 'approved' && <Link to="/" className="btn primary">Go to dashboard</Link>}
      </section>

      {Object.entries(SLOTS).map(([kind, slot]) => {
        const doc = state.documents.find((d) => d.kind === kind);
        const label = config.documentKinds[kind];
        return (
          <section key={kind} className="card doc-slot">
            <div className="doc-slot-head">
              <div className="grow">
                <h3>{doc ? '✅' : '⬜️'} {label}</h3>
                <p className="muted small">{slot.hint}</p>
              </div>
              {doc && <DocumentPreview doc={doc} label={label} />}
            </div>
            {editable && (
              <label className={`btn block upload-btn ${busy === kind ? 'busy' : ''}`}>
                {busy === kind ? 'Uploading…' : doc ? 'Replace' : kind === 'selfie' ? '📷 Take or upload a selfie' : '⬆️ Upload'}
                <input
                  type="file"
                  accept={slot.accept}
                  capture={slot.capture}
                  hidden
                  disabled={!!busy}
                  onChange={(e) => {
                    choose(kind, e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </section>
        );
      })}

      {error && <p className="error">{error}</p>}
      {editable && (
        <button className="btn primary lg block" disabled={!!busy || state.missing.length > 0} onClick={submit}>
          {state.missing.length ? `Upload ${state.missing.length} more to submit` : busy === 'submit' ? 'Submitting…' : 'Submit for review'}
        </button>
      )}
      <p className="hint center">🔒 Your documents are only visible to you and our verification team. JPG, PNG, WebP or PDF, up to 8 MB.</p>
    </div>
  );
}
