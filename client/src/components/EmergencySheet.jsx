import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../session.jsx';

/**
 * The emergency button. Pressing it alerts the ProNow team straight away (no confirm step) and shows
 * the emergency numbers. The phone's location is added if the person allows it.
 */
export default function EmergencyButton({ job, onChange }) {
  const [open, setOpen] = useState(false);
  const [alert, setAlert] = useState(job.myEmergency ?? null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  async function press() {
    setOpen(true);
    setError('');
    try {
      const raised = await api(`/jobs/${job.id}/emergency`, { method: 'POST', body: {} });
      setAlert(raised);
      onChange?.();
      // Location follows if the phone gives it; the alert never waits for it.
      navigator.geolocation?.getCurrentPosition(
        (p) => api(`/emergencies/${raised.id}`, { method: 'PATCH', body: { lat: p.coords.latitude, lng: p.coords.longitude } }).then(setAlert).catch(() => {}),
        () => {},
        { enableHighAccuracy: true, timeout: 10000 },
      );
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <>
      <button className="btn sos" onClick={press} aria-haspopup="dialog">🆘 Emergency</button>
      {open && <EmergencySheet alert={alert} error={error} note={note} setNote={setNote} setAlert={setAlert} onClose={() => setOpen(false)} />}
    </>
  );
}

function EmergencySheet({ alert, error, note, setNote, setAlert, onClose }) {
  const { config } = useSession();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  async function update(body) {
    setBusy(true);
    try {
      setAlert(await api(`/emergencies/${alert.id}`, { method: 'PATCH', body }));
    } finally {
      setBusy(false);
    }
  }

  const cancelled = alert?.status === 'false_alarm';
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet emergency" role="dialog" aria-modal="true" aria-labelledby="sos-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="sos-title">Emergency</h2>
        <p>If you are in danger, call now:</p>
        <div className="sos-numbers">
          {config.emergencyNumbers.map((n) => (
            <a key={n.number} className="btn sos-call" href={`tel:${n.number}`}>
              <strong>📞 {n.number}</strong>
              <span>{n.label}</span>
            </a>
          ))}
        </div>

        <div className={`sos-status ${cancelled ? 'cancelled' : ''}`}>
          {error ? <p className="error">{error}</p>
            : !alert ? <p>Alerting the ProNow safety team…</p>
              : cancelled ? <p>Alert cancelled. Glad you're safe.</p>
                : (
                  <>
                    <p><strong>✓ The ProNow safety team has been alerted</strong> with your job details{alert.location ? ' and your location' : ''}. They will contact you.</p>
                    <textarea rows={2} maxLength={500} placeholder="Anything we should know? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                    <div className="row">
                      <button className="btn grow" disabled={busy || !note.trim()} onClick={() => update({ note }).then(() => setNote(''))}>Send note</button>
                      <button className="btn grow" disabled={busy || alert.status !== 'open'} onClick={() => update({ cancel: true })}>I'm safe, cancel alert</button>
                    </div>
                  </>
                )}
        </div>
        <button className="link close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
