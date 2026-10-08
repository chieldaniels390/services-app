import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import MapView from '../components/MapView.jsx';
import { Stars } from '../components/Stars.jsx';
import { STATUS_LABELS, money, when } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

const ASSIGNED = ['accepted', 'en_route', 'arrived', 'in_progress'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function ProviderHome() {
  const { user, setUser, config, categories } = useSession();
  const navigate = useNavigate();
  const profile = user.provider;
  const [requests, setRequests] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [fresh, setFresh] = useState(new Set());
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const refresh = useCallback(() => {
    api('/provider/requests').then(setRequests).catch((e) => setError(e.message));
    api('/jobs').then((jobs) => setActiveJob(jobs.find((j) => ASSIGNED.includes(j.status)) ?? null)).catch(() => {});
    api('/provider/earnings').then(setEarnings).catch(() => {});
  }, []);
  useEffect(refresh, [refresh, profile.online]);

  useSocketEvent('job:offer', (job) => {
    setRequests((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setFresh((s) => new Set(s).add(job.id));
  });
  useSocketEvent('job:taken', ({ id }) => setRequests((prev) => prev.filter((j) => j.id !== id)));
  useSocketEvent('job:updated', refresh);

  async function updateStatus(body) {
    setError('');
    try {
      setUser(await api('/provider/status', { method: 'PATCH', body }));
    } catch (e) {
      setError(e.message);
    }
  }

  function goOnline() {
    if (profile.location) return updateStatus({ online: true });
    if (!navigator.geolocation) return updateStatus({ online: true, ...config.defaultCenter });
    navigator.geolocation.getCurrentPosition(
      (p) => updateStatus({ online: true, lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {
        setError('Could not read your location, so we placed you in the city centre. Tap the map to adjust.');
        updateStatus({ online: true, ...config.defaultCenter });
      },
      { timeout: 10000 },
    );
  }

  async function accept(id) {
    setBusyId(id);
    setError('');
    try {
      await api(`/jobs/${id}/accept`, { method: 'POST' });
      navigate(`/jobs/${id}`);
    } catch (e) {
      setError(e.message);
      setRequests((prev) => prev.filter((j) => j.id !== id));
      setBusyId(null);
    }
  }

  const here = profile.location ?? config.defaultCenter;
  const markers = [
    ...(profile.location ? [{ id: 'me', ...profile.location, emoji: '🚐', variant: 'pro', label: 'You' }] : []),
    ...requests.map((j) => ({ id: `job-${j.id}`, ...j.location, emoji: j.category.icon, variant: 'home', label: `${j.category.name} · ${money(j.payoutCents)}` })),
  ];
  const myServices = categories.filter((c) => profile.categories.includes(c.id));

  return (
    <div className="provider-home">
      <section className={`card online-card ${profile.online ? 'online' : ''}`}>
        <div className="grow">
          <h2>{profile.online ? "You're online" : "You're offline"}</h2>
          <p className="muted small">
            {profile.online ? 'New requests nearby will pop up here instantly.' : 'Go online to start receiving job requests.'}
          </p>
          <p className="small">
            <Stars value={profile.rating} count={profile.ratingCount} /> · {myServices.map((c) => c.icon).join(' ')}
          </p>
        </div>
        <button className={`toggle ${profile.online ? 'on' : ''}`} onClick={() => (profile.online ? updateStatus({ online: false }) : goOnline())} aria-pressed={profile.online}>
          <span />
        </button>
      </section>

      {error && <p className="error">{error}</p>}

      {activeJob && (
        <Link to={`/jobs/${activeJob.id}`} className="banner">
          <span className="icon">{activeJob.category.icon}</span>
          <span><strong>Current job</strong> · {STATUS_LABELS[activeJob.status]} · {activeJob.customer.name}</span>
          <span className="arrow">›</span>
        </Link>
      )}

      {earnings && (
        <section className="stats">
          <div><span className="muted small">Today</span><strong>{money(earnings.today.cents)}</strong><span className="muted small">{plural(earnings.today.jobs, 'job')}</span></div>
          <div><span className="muted small">Last 7 days</span><strong>{money(earnings.week.cents)}</strong><span className="muted small">{plural(earnings.week.jobs, 'job')}</span></div>
          <div><span className="muted small">All time</span><strong>{money(earnings.allTime.cents)}</strong><span className="muted small">{plural(earnings.allTime.jobs, 'job')}</span></div>
        </section>
      )}

      <MapView
        center={here}
        markers={markers}
        frame={[here, ...requests.slice(0, 5).map((j) => j.location)]}
        onPick={(p) => updateStatus(p)}
      />
      <p className="hint">Tap the map to update your position.</p>

      <h3>Requests near you</h3>
      {!profile.online && <p className="muted">Go online to see requests.</p>}
      {profile.online && requests.length === 0 && <p className="muted">No open requests right now. Hang tight — we'll alert you.</p>}
      <div className="request-list">
        {requests.map((j) => (
          <article key={j.id} className={`card request ${fresh.has(j.id) ? 'fresh' : ''}`}>
            <div className="request-head">
              <span className="icon">{j.category.icon}</span>
              <div className="grow">
                <strong>{j.category.name}</strong> <span className="muted small">· {j.sizeLabel}</span>
                <div className="muted small">
                  {j.distanceKm} km · ~{j.etaMinutes} min away{j.scheduledFor ? ` · ${when(j.scheduledFor)}` : ' · ASAP'}
                </div>
              </div>
              <strong className="earn">{money(j.payoutCents)}</strong>
            </div>
            <p>{j.description}</p>
            <div className="row">
              <Link className="btn grow" to={`/jobs/${j.id}`}>Details</Link>
              <button className="btn primary grow" disabled={busyId === j.id || !!activeJob} onClick={() => accept(j.id)}>
                {activeJob ? 'Finish current job first' : 'Accept'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
