import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import MapView from '../components/MapView.jsx';
import { ACTIVE_STATUSES, STATUS_LABELS, money } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

export default function CustomerHome() {
  const { categories, config, user } = useSession();
  const navigate = useNavigate();
  const [categoryId, setCategoryId] = useState(null);
  const [size, setSize] = useState('small');
  const [location, setLocation] = useState(config.defaultCenter);
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [timing, setTiming] = useState('now');
  const [scheduledFor, setScheduledFor] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [activeJobs, setActiveJobs] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const category = categories.find((c) => c.id === categoryId);

  const loadActive = () => api('/jobs').then((jobs) => setActiveJobs(jobs.filter((j) => ACTIVE_STATUSES.includes(j.status))));
  useEffect(() => { loadActive().catch(() => {}); }, []);
  useSocketEvent('job:updated', () => loadActive().catch(() => {}));

  useEffect(() => {
    if (!categoryId) return undefined;
    const t = setTimeout(() => {
      api('/estimate', { method: 'POST', body: { categoryId, size, ...location } })
        .then(setEstimate)
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [categoryId, size, location]);

  function locate() {
    if (!navigator.geolocation) return setError('Location is not available in this browser - tap the map instead');
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setError('Could not get your location - tap the map to place the pin'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { job } = await api('/jobs', {
        method: 'POST',
        body: {
          categoryId, size, description, address, ...location,
          scheduledFor: timing === 'later' && scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
        },
      });
      navigate(`/jobs/${job.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const markers = [
    { id: 'home', ...location, emoji: '🏠', variant: 'home', label: 'Job location' },
    ...(estimate?.nearby ?? []).map((p, i) => ({ id: `pro-${i}`, ...p, emoji: category?.icon ?? '🧰', variant: 'pro' })),
  ];

  return (
    <div className="customer-home">
      {activeJobs.map((j) => (
        <Link key={j.id} to={`/jobs/${j.id}`} className="banner">
          <span className="icon">{j.category.icon}</span>
          <span><strong>{j.category.name}</strong> · {STATUS_LABELS[j.status]}{j.provider ? ` · ${j.provider.name}` : ''}</span>
          <span className="arrow">›</span>
        </Link>
      ))}

      {!category ? (
        <>
          <h2>Hi {user.name.split(' ')[0]}, what do you need help with?</h2>
          <div className="grid categories">
            {categories.map((c) => (
              <button key={c.id} className="category" onClick={() => { setCategoryId(c.id); setEstimate(null); setError(''); }}>
                <span className="icon">{c.icon}</span>
                <strong>{c.name}</strong>
                <span className="muted small">{c.description}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="request-layout">
          <MapView className="tall" center={location} markers={markers} frame={[location, ...(estimate?.nearby ?? []).slice(0, 3)]} onPick={setLocation} />

          <form className="card request-form" onSubmit={submit}>
            <button type="button" className="link back" onClick={() => setCategoryId(null)}>‹ All services</button>
            <h2>{category.icon} {category.name}</h2>

            <label>
              Where?
              <div className="row">
                <input required placeholder="Street address, flat number…" value={address} onChange={(e) => setAddress(e.target.value)} />
                <button type="button" className="btn" onClick={locate} title="Use my location">📍</button>
              </div>
              <span className="hint">Tap the map to move the pin.</span>
            </label>

            <label>
              What's the problem?
              <textarea required rows={3} maxLength={1000} placeholder="e.g. Kitchen sink is leaking under the cabinet" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>

            <div className="field">
              <span>How big is the job?</span>
              <div className="segmented">
                {Object.entries(config.jobSizes).map(([key, s]) => (
                  <button type="button" key={key} className={size === key ? 'on' : ''} onClick={() => setSize(key)}>
                    {s.label}<small>~{s.hours}h</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span>When?</span>
              <div className="segmented">
                <button type="button" className={timing === 'now' ? 'on' : ''} onClick={() => setTiming('now')}>ASAP</button>
                <button type="button" className={timing === 'later' ? 'on' : ''} onClick={() => setTiming('later')}>Schedule</button>
              </div>
              {timing === 'later' && (
                <input type="datetime-local" required value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
              )}
            </div>

            {estimate && (
              <div className="quote">
                <div className="quote-total">
                  <span>Upfront price</span>
                  <strong>{money(estimate.totalCents, config.currency)}</strong>
                </div>
                <div className="quote-lines small muted">
                  <span>Call-out {money(estimate.calloutCents, config.currency)}</span>
                  <span>Labour {estimate.hours}h · {money(estimate.labourCents, config.currency)}</span>
                  {estimate.surge > 1 && <span className="surge">High demand ×{estimate.surge}</span>}
                </div>
                <p className="small">
                  {estimate.availableProviders
                    ? <>🟢 {estimate.availableProviders} pro{estimate.availableProviders > 1 ? 's' : ''} nearby · arrives in ~{estimate.etaMinutes} min</>
                    : <>🟠 No pros online nearby right now — you can still request and we'll notify pros as they come online.</>}
                </p>
                <p className="hint">Parts and materials, if needed, are added at cost by your pro.</p>
              </div>
            )}

            {error && <p className="error">{error}</p>}
            <button className="btn primary lg block" disabled={busy || !estimate}>
              Request {category.name.toLowerCase()} pro{estimate ? ` · ${money(estimate.totalCents, config.currency)}` : ''}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
