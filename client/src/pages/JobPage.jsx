import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Chat from '../components/Chat.jsx';
import MapView from '../components/MapView.jsx';
import StatusTimeline from '../components/StatusTimeline.jsx';
import { StarInput, Stars } from '../components/Stars.jsx';
import { STATUS_LABELS, currencySymbol, distanceKm, etaMinutes, money, when } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

const NEXT_ACTION = {
  accepted: { status: 'en_route', label: 'Start driving' },
  en_route: { status: 'arrived', label: "I've arrived" },
  arrived: { status: 'in_progress', label: 'Start work' },
  in_progress: { status: 'completed', label: 'Complete job' },
};
const ASSIGNED = ['accepted', 'en_route', 'arrived', 'in_progress'];

function headline(job, isPro) {
  const pro = job.provider?.name.split(' ')[0];
  const customer = job.customer.name.split(' ')[0];
  switch (job.status) {
    case 'requested': return isPro ? 'New request' : 'Finding you a pro…';
    case 'accepted': return isPro ? `Head to ${customer} when ready` : `${pro} accepted your job`;
    case 'en_route': return isPro ? `Driving to ${customer}` : `${pro} is on the way`;
    case 'arrived': return isPro ? 'You have arrived' : `${pro} has arrived`;
    case 'in_progress': return 'Work in progress';
    case 'completed': return 'Job complete';
    case 'cancelled': return job.cancelledBy === 'customer' && !isPro ? 'You cancelled this request' : 'This job was cancelled';
    default: return STATUS_LABELS[job.status];
  }
}

/** Moves the pro toward the job in small steps so the live-tracking flow can be demoed without driving. */
function useSimulatedDrive(active, from, to, emit) {
  const pos = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    pos.current = from ?? { lat: to.lat + 0.02, lng: to.lng - 0.02 };
    const timer = setInterval(() => {
      const remaining = distanceKm(pos.current, to);
      if (remaining < 0.03) return clearInterval(timer);
      const step = Math.min(1, Math.max(0.12, 0.05 / remaining));
      pos.current = {
        lat: pos.current.lat + (to.lat - pos.current.lat) * step,
        lng: pos.current.lng + (to.lng - pos.current.lng) * step,
      };
      emit(pos.current);
    }, 1000);
    return () => clearInterval(timer);
    // Only restart when toggled; `from` changes every tick as a result of emitting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, to.lat, to.lng]);
}

function useLiveGps(active, emit) {
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return undefined;
    if (!navigator.geolocation) {
      setError('GPS is not available in this browser');
      return undefined;
    }
    const watch = navigator.geolocation.watchPosition(
      (p) => emit({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setError('Could not read your GPS position'),
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [active, emit]);
  return error;
}

export default function JobPage() {
  const jobId = Number(useParams().id);
  const { user, socket } = useSession();
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [materials, setMaterials] = useState('');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [simulating, setSimulating] = useState(false);
  const [sharingGps, setSharingGps] = useState(false);
  const isPro = user.role === 'provider';

  const load = useCallback(() => {
    api(`/jobs/${jobId}`)
      .then((j) => { setJob(j); setError(''); })
      .catch((e) => setError(e.status === 403 ? 'This job is no longer available.' : e.message));
  }, [jobId]);
  useEffect(load, [load]);

  useSocketEvent('job:updated', (j) => j.id === jobId && setJob(j));
  useSocketEvent('job:taken', ({ id }) => id === jobId && isPro && job?.status === 'requested' && load());
  useSocketEvent('job:released', ({ id }) => id === jobId && navigate('/'));
  useSocketEvent('provider:location', ({ jobId: id, lat, lng }) => {
    if (id !== jobId) return;
    setJob((j) => (j?.provider ? { ...j, provider: { ...j.provider, location: { lat, lng } } } : j));
  });

  const emitLocation = useCallback((point) => {
    socket?.emit('location', point);
    setJob((j) => (j?.provider ? { ...j, provider: { ...j.provider, location: point } } : j));
  }, [socket]);

  const mine = isPro && job?.provider?.id === user.id;
  useSimulatedDrive(simulating && mine && job?.status === 'en_route', job?.provider?.location, job?.location ?? {}, emitLocation);
  const gpsError = useLiveGps(sharingGps && mine && ASSIGNED.includes(job?.status), emitLocation);

  async function act(path, body) {
    setBusy(true);
    setError('');
    try {
      const result = await api(`/jobs/${jobId}${path}`, { method: 'POST', body });
      if (result.status === 'released') return navigate('/');
      setJob(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!job) {
    return (
      <div className="card center">
        {error ? <><p className="error">{error}</p><Link to="/" className="btn">Back home</Link></> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const next = mine && NEXT_ACTION[job.status];
  const providerLoc = job.provider?.location;
  const customerCanCancel = !isPro && ['requested', 'accepted', 'en_route'].includes(job.status);
  const proCanRelease = mine && ['accepted', 'en_route'].includes(job.status);
  const eta = job.status === 'en_route' && providerLoc ? etaMinutes(distanceKm(providerLoc, job.location)) : null;
  const markers = [
    { id: 'job', ...job.location, emoji: '🏠', variant: 'home', label: isPro && !mine ? 'Approximate area' : 'Job location' },
    ...(providerLoc ? [{ id: 'pro', ...providerLoc, emoji: '🚐', variant: 'pro', label: job.provider.name }] : []),
  ];

  return (
    <div className="job-layout">
      <MapView className="tall" center={job.location} markers={markers} frame={[job.location, providerLoc]} />

      <div className="job-panel">
        <section className={`card status-card status-${job.status}`}>
          <div className="status-head">
            <span className="icon">{job.category.icon}</span>
            <div>
              <h2>{headline(job, isPro)}</h2>
              <p className="muted small">
                {job.category.name} · {job.sizeLabel}
                {job.scheduledFor && <> · Scheduled {when(job.scheduledFor)}</>}
              </p>
            </div>
          </div>
          {job.status === 'requested' && !isPro && <div className="searching"><span /></div>}
          {eta != null && <p className="eta">Arriving in about <strong>{eta} min</strong></p>}
          <StatusTimeline job={job} />
        </section>

        {!isPro && job.provider && (
          <section className="card person">
            <div className="avatar">{job.provider.name[0]}</div>
            <div className="grow">
              <strong>{job.provider.name}</strong>
              <div><Stars value={job.provider.rating} count={job.provider.ratingCount} /></div>
            </div>
            {job.provider.phone && ASSIGNED.includes(job.status) && <a className="btn" href={`tel:${job.provider.phone}`}>📞 Call</a>}
          </section>
        )}

        {mine && (
          <section className="card person">
            <div className="avatar">{job.customer.name[0]}</div>
            <div className="grow">
              <strong>{job.customer.name}</strong>
              <div className="muted small">{job.address}</div>
            </div>
            {job.customer.phone && ASSIGNED.includes(job.status) && <a className="btn" href={`tel:${job.customer.phone}`}>📞</a>}
            {ASSIGNED.includes(job.status) && (
              <a className="btn" target="_blank" rel="noreferrer"
                href={`https://www.google.com/maps/dir/?api=1&destination=${job.location.lat},${job.location.lng}`}>🧭</a>
            )}
          </section>
        )}

        <section className="card">
          <h3>Job details</h3>
          <p>{job.description}</p>
          {job.address && !mine && <p className="muted small">📍 {job.address}</p>}
          {isPro && job.distanceKm != null && <p className="muted small">{job.distanceKm} km away · ~{job.etaMinutes} min</p>}
          <dl className="price-lines">
            <dt>Upfront price{job.surge > 1 && <span className="surge"> ×{job.surge}</span>}</dt>
            <dd>{money(job.estimatedCents)}</dd>
            {job.status === 'completed' && (
              <>
                <dt>Materials</dt><dd>{money(job.materialsCents)}</dd>
                <dt><strong>Total</strong></dt><dd><strong>{money(job.finalCents)}</strong></dd>
              </>
            )}
            {isPro && (
              <>
                {job.status === 'completed' && <><dt>Platform fee</dt><dd>−{money(job.finalCents - job.payoutCents)}</dd></>}
                <dt><strong>{job.status === 'completed' ? 'You earned' : 'Your payout'}</strong></dt>
                <dd><strong className="earn">{money(job.payoutCents)}</strong></dd>
              </>
            )}
          </dl>
        </section>

        {error && <p className="error">{error}</p>}

        {isPro && job.status === 'requested' && (
          <button className="btn primary lg block" disabled={busy} onClick={() => act('/accept')}>
            Accept job · earn {money(job.payoutCents)}
          </button>
        )}

        {next && (
          <section className="card actions-card">
            {next.status === 'completed' && (
              <label>
                Materials / parts cost ({currencySymbol()})
                <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" value={materials} onChange={(e) => setMaterials(e.target.value)} />
              </label>
            )}
            <button
              className="btn primary lg block"
              disabled={busy}
              onClick={() => act('/status', { status: next.status, materialsCents: Math.round(Number(materials || 0) * 100) })}
            >
              {next.label}
            </button>
            {job.status === 'en_route' && (
              <div className="row">
                <button className={`btn grow ${sharingGps ? 'on' : ''}`} onClick={() => setSharingGps((v) => !v)}>
                  {sharingGps ? '📡 Sharing live GPS' : '📡 Share live GPS'}
                </button>
                <button className={`btn grow ${simulating ? 'on' : ''}`} onClick={() => setSimulating((v) => !v)}>
                  {simulating ? 'Stop demo drive' : '▶︎ Demo drive'}
                </button>
              </div>
            )}
            {gpsError && <p className="error small">{gpsError}</p>}
          </section>
        )}

        {(customerCanCancel || proCanRelease) && (
          <button
            className="btn danger block"
            disabled={busy}
            onClick={() => window.confirm(proCanRelease ? 'Release this job so another pro can take it?' : 'Cancel this request?') && act('/cancel')}
          >
            {proCanRelease ? 'Release job' : 'Cancel request'}
          </button>
        )}

        {!isPro && job.status === 'completed' && !job.review && (
          <section className="card">
            <h3>How did {job.provider.name.split(' ')[0]} do?</h3>
            <StarInput value={rating} onChange={setRating} />
            <textarea rows={2} maxLength={500} placeholder="Add a comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="btn primary block" disabled={!rating || busy} onClick={() => act('/rate', { rating, comment })}>Submit rating</button>
          </section>
        )}

        {job.review && (
          <section className="card">
            <h3>Rating</h3>
            <p className="stars">{'★'.repeat(job.review.rating)}{'☆'.repeat(5 - job.review.rating)}</p>
            {job.review.comment && <p className="muted">“{job.review.comment}”</p>}
          </section>
        )}

        {job.provider && (job.status !== 'requested') && (mine || !isPro) && (
          <Chat jobId={job.id} readOnly={!ASSIGNED.includes(job.status)} />
        )}
      </div>
    </div>
  );
}
