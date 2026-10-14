import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import MapView, { circleBounds } from '../components/MapView.jsx';
import PushPrompt from '../components/PushPrompt.jsx';
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
  useSocketEvent('payouts:updated', refresh);

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
  // Where requests can come from: the pro's chosen area, or the default radius around them.
  const area = profile.serviceArea ?? (profile.location && { ...profile.location, radiusKm: config.defaultRadiusKm });
  const { withinHours, hoursToday } = profile.availability;

  if (profile.verificationStatus !== 'approved') {
    const pending = profile.verificationStatus === 'pending';
    return (
      <div className="provider-home">
        <section className="card verify-cta">
          <span className="icon">{pending ? '⏳' : '🪪'}</span>
          <div className="grow">
            <h2>{pending ? 'Verification in progress' : profile.verificationStatus === 'rejected' ? 'Action needed on your verification' : 'Verify your account'}</h2>
            <p className="muted">
              {pending
                ? "We're checking your documents. You'll be able to go online and receive jobs once you're approved."
                : 'Upload your ID, trade certificate or licence, and a selfie. You can receive jobs once we approve them.'}
            </p>
          </div>
          <Link to="/verification" className="btn primary">{pending ? 'View' : 'Start'}</Link>
        </section>
        {!profile.payoutAccount && (
          <Link to="/payouts" className="banner warn">
            <span className="icon">🏦</span>
            <span>While you wait: <strong>add your bank account</strong> so we can pay you.</span>
            <span className="arrow">›</span>
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="provider-home">
      <section className={`card online-card ${profile.online ? 'online' : ''}`}>
        <div className="grow">
          <h2>{profile.online ? "You're online" : "You're offline"}</h2>
          <p className="muted small">
            {!profile.online
              ? 'Go online to start receiving job requests.'
              : withinHours
                ? 'New requests in your area will pop up here instantly.'
                : `You're outside your working hours (today: ${hoursToday}), so you won't get new requests until your next shift.`}
          </p>
          <p className="small">
            <Stars value={profile.rating} count={profile.ratingCount} /> · {myServices.map((c) => c.icon).join(' ')}
            {profile.pendingCategories.length > 0 && <span className="muted"> · {profile.pendingCategories.length} trade awaiting approval</span>}
          </p>
          <p className="small">
            {profile.serviceArea ? `Within ${profile.serviceArea.radiusKm} km` : `Within ${config.defaultRadiusKm} km of you`}
            {' · '}{profile.workingHours ? `Today ${hoursToday}` : 'Any time'}
            {' · '}<Link to="/work">Work settings</Link>
            {' · '}<Link to={`/pros/${user.id}`}>My profile</Link>
          </p>
        </div>
        <button className={`toggle ${profile.online ? 'on' : ''}`} onClick={() => (profile.online ? updateStatus({ online: false }) : goOnline())} aria-pressed={profile.online}>
          <span />
        </button>
      </section>

      {error && <p className="error">{error}</p>}
      {profile.online && <PushPrompt message="Turn on notifications so you never miss a job request." />}

      {!profile.payoutAccount && (
        <Link to="/payouts" className="banner warn">
          <span className="icon">🏦</span>
          <span><strong>Add your bank account</strong> so we can pay you when you finish jobs.</span>
          <span className="arrow">›</span>
        </Link>
      )}

      {activeJob && (
        <Link to={`/jobs/${activeJob.id}`} className="banner">
          <span className="icon">{activeJob.category.icon}</span>
          <span><strong>Current job</strong> · {STATUS_LABELS[activeJob.status]} · {activeJob.customer.name}</span>
          <span className="arrow">›</span>
        </Link>
      )}

      {earnings && (
        <Link to="/earnings" className="stats stats-link">
          {[['today', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([key, label]) => (
            <div key={key}>
              <span className="muted small">{label}</span>
              <strong>{money(earnings.periods[key].earningsCents)}</strong>
              <span className="muted small">{plural(earnings.periods[key].jobs, 'job')}</span>
            </div>
          ))}
        </Link>
      )}
      {earnings && earnings.payouts.pendingCents > 0 && (
        <Link to="/earnings" className="small">{money(earnings.payouts.pendingCents)} on its way to your bank ›</Link>
      )}

      <MapView
        center={here}
        markers={markers}
        circles={area ? [{ id: 'area', ...area }] : []}
        frame={[here, ...(area ? circleBounds(area) : []), ...requests.slice(0, 5).map((j) => j.location)]}
        onPick={(p) => updateStatus(p)}
      />
      <p className="hint">The circle is your service area. Tap the map to update your current position.</p>

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
                {j.askedForYou && <span className="pill asked">⭐ Asked for you</span>}
                <div className="muted small">
                  {j.distanceKm} km · ~{j.etaMinutes} min away{j.scheduledFor ? ` · ${when(j.scheduledFor)}` : ' · ASAP'}
                </div>
                <div className="small">{j.customer.name.split(' ')[0]} · <Stars value={j.customer.rating} count={j.customer.ratingCount} empty="New customer" /></div>
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
