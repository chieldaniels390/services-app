import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import AddressSearch from '../components/AddressSearch.jsx';
import MapView from '../components/MapView.jsx';
import { ACTIVE_STATUSES, STATUS_LABELS, distanceKm, goToCheckout, money, zonedInputToIso } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

export default function CustomerHome() {
  const { categories, config, user } = useSession();
  const [categoryId, setCategoryId] = useState(null);
  const [size, setSize] = useState(null); // no default: the full estimate shows once the customer picks a size
  const [location, setLocation] = useState(config.defaultCenter);
  const [focus, setFocus] = useState(null);
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [timing, setTiming] = useState('now');
  const [scheduledFor, setScheduledFor] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [activeJobs, setActiveJobs] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [frequency, setFrequency] = useState('weekly');
  const [preferredPro, setPreferredPro] = useState(null); // { id, name } when booking a specific pro again
  const [params, setParams] = useSearchParams();
  const category = categories.find((c) => c.id === categoryId);
  // "Repeat" and "Schedule" both pick a date and time; repeat uses it as the first visit.
  const pickedTime = timing !== 'now' && scheduledFor ? zonedInputToIso(scheduledFor) : undefined;

  // Prefill from "Book again" (?rebook=<job>) or a favourite pro (?pro=<id>&category=<trade>).
  useEffect(() => {
    const rebook = params.get('rebook');
    const pro = params.get('pro');
    if (!rebook && !pro) return;
    setParams({}, { replace: true });
    if (rebook) {
      api(`/jobs/${rebook}`).then((job) => {
        setCategoryId(job.category.id);
        setSize(job.size);
        setDescription(job.description);
        setAddress(job.address);
        setLocation(job.location);
        setFocus(job.location);
        if (job.provider) setPreferredPro({ id: job.provider.id, name: job.provider.name });
      }).catch((e) => setError(e.message));
    } else {
      api(`/pros/${pro}`).then((p) => {
        if (p.workedWithYou) setPreferredPro({ id: p.id, name: p.name });
        setCategoryId(params.get('category') ?? p.trades[0] ?? null);
      }).catch((e) => setError(e.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadActive = () => api('/jobs').then((jobs) => setActiveJobs(jobs.filter((j) => ACTIVE_STATUSES.includes(j.status))));
  useEffect(() => { loadActive().catch(() => {}); }, []);
  useSocketEvent('job:updated', () => loadActive().catch(() => {}));

  useEffect(() => {
    if (!categoryId || !size) return undefined;
    const t = setTimeout(() => {
      // Pros are matched on their working hours at the booked time, so a scheduled quote checks that time.
      api('/estimate', { method: 'POST', body: { categoryId, size, ...location, scheduledFor: pickedTime, preferredProviderId: preferredPro?.id } })
        .then((est) => { setEstimate(est); setError(''); })
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, size, location, timing, scheduledFor, preferredPro]);

  // Latest reverse lookup wins, so quick successive taps can't leave a stale address behind.
  const lookup = useRef(0);
  async function placePin(point, { zoom = false } = {}) {
    setLocation(point);
    if (zoom) setFocus(point);
    const n = ++lookup.current;
    try {
      const place = await api(`/geocode/reverse?lat=${point.lat}&lng=${point.lng}`);
      if (n === lookup.current && place) setAddress(place.label);
    } catch {
      // Address lookup is a convenience; the pin is what matters.
    }
  }

  function chooseAddress(result) {
    lookup.current++;
    setAddress(result.label);
    setLocation({ lat: result.lat, lng: result.lng });
    setFocus({ lat: result.lat, lng: result.lng });
  }

  function locate() {
    if (!navigator.geolocation) return setError('Location is not available in this browser - tap the map instead');
    navigator.geolocation.getCurrentPosition(
      (pos) => placePin({ lat: pos.coords.latitude, lng: pos.coords.longitude }, { zoom: true }),
      () => setError('Could not get your location - tap the map to place the pin'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const details = { categoryId, size, description, address, ...location, preferredProviderId: preferredPro?.id };
      const { payment } = timing === 'repeat'
        ? await api('/recurring', { method: 'POST', body: { ...details, frequency, firstVisitAt: pickedTime } })
        : await api('/jobs', { method: 'POST', body: { ...details, scheduledFor: pickedTime } });
      goToCheckout(payment.authorizationUrl);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const markers = [
    { id: 'home', ...location, emoji: '🏠', variant: 'home', label: 'Job location' },
    ...(estimate?.nearby ?? []).map((p, i) => ({ id: `pro-${i}`, ...p, emoji: category?.icon ?? '🧰', variant: 'pro' })),
  ];
  // Keep the closest pros in shot, but ignore ones left over from a quote for a far-away pin.
  const frame = [location, ...(estimate?.nearby ?? []).filter((p) => distanceKm(p, location) < 15).slice(0, 3)];

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
              <button key={c.id} className="category" onClick={() => { setCategoryId(c.id); setSize(null); setEstimate(null); setError(''); }}>
                <span className="icon">{c.icon}</span>
                <strong>{c.name}</strong>
                <span className="muted small">{c.description}</span>
                <span className="from-price">Call-out from {money(c.calloutCents)}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="request-layout">
          <MapView className="tall" center={location} markers={markers} frame={frame} focus={focus} onPick={placePin} />

          <form className="card request-form" onSubmit={submit}>
            <button type="button" className="link back" onClick={() => setCategoryId(null)}>‹ All services</button>
            <h2>{category.icon} {category.name}</h2>

            <div className="field">
              <span>Where?</span>
              <AddressSearch value={address} onChange={setAddress} onSelect={chooseAddress}>
                <button type="button" className="btn" onClick={locate} title="Use my location" aria-label="Use my location">📍</button>
              </AddressSearch>
              <span className="hint">Pick a suggestion or tap the map to place the pin. Add your unit or complex number after.</span>
            </div>

            <label>
              What's the problem?
              <textarea required rows={3} maxLength={1000} placeholder="e.g. Kitchen sink is leaking under the cabinet" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>

            <div className="field">
              <span>How big is the job?</span>
              <div className="segmented">
                {Object.entries(config.jobSizes).map(([key, s]) => (
                  <button type="button" key={key} className={size === key ? 'on' : ''} aria-pressed={size === key} onClick={() => setSize(key)}>
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
                <button type="button" className={timing === 'repeat' ? 'on' : ''} onClick={() => setTiming('repeat')}>Repeat</button>
              </div>
              {timing === 'repeat' && (
                <div className="segmented">
                  <button type="button" className={frequency === 'weekly' ? 'on' : ''} onClick={() => setFrequency('weekly')}>Every week</button>
                  <button type="button" className={frequency === 'monthly' ? 'on' : ''} onClick={() => setFrequency('monthly')}>Every month</button>
                </div>
              )}
              {timing !== 'now' && (
                <label className="sub-label">
                  {timing === 'repeat' ? 'First visit' : 'Date and time'} <span className="muted small">(South African time)</span>
                  <input type="datetime-local" required value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
                </label>
              )}
              {timing === 'repeat' && (
                <p className="hint">
                  You pay for the first visit now. Each later visit is booked {Math.round(config.recurringLeadHours / 24)} days ahead and charged to the same card at the standard rate.
                  You can skip, pause or stop it any time under My bookings.
                </p>
              )}
            </div>

            {preferredPro && (
              <div className="preferred">
                <span className="grow">
                  <strong>Booking {preferredPro.name} again.</strong>{' '}
                  {estimate?.preferred && !estimate.preferred.available
                    ? `${preferredPro.name.split(' ')[0]} isn't available ${timing === 'now' ? 'right now' : 'at that time'}, so your request will go to other trusted pros.`
                    : `${preferredPro.name.split(' ')[0]} gets it first. If they can't take it within a few minutes, it goes to other pros.`}
                </span>
                <button type="button" className="link" aria-label="Book any pro instead" onClick={() => setPreferredPro(null)}>✕</button>
              </div>
            )}

            {!size && (
              <div className="quote pending-quote">
                <span>Call-out from <strong>{money(category.calloutCents)}</strong></span>
                <p className="muted small">Pick how big the job is to see your full upfront price.</p>
              </div>
            )}

            {size && estimate && (
              <div className="quote">
                <div className="quote-total">
                  <span>Upfront price</span>
                  <strong>{money(estimate.totalCents)}</strong>
                </div>
                <div className="quote-lines small muted">
                  <span>Call-out {money(estimate.calloutCents)}</span>
                  <span>Labour {estimate.hours}h · {money(estimate.labourCents)}</span>
                  {estimate.surge > 1 && <span className="surge">High demand ×{estimate.surge}</span>}
                </div>
                <p className="small">
                  {estimate.availableProviders
                    ? <>🟢 {estimate.availableProviders} pro{estimate.availableProviders > 1 ? 's' : ''} nearby · arrives in ~{estimate.etaMinutes} min</>
                    : <>🟠 No pros online nearby right now — you can still request and we'll notify pros as they come online.</>}
                </p>
                <p className="hint">Parts and materials, if needed, are added at cost by your pro and need your approval.</p>
              </div>
            )}

            {error && <p className="error">{error}</p>}
            <button className="btn primary lg block" disabled={busy || !size || !estimate || !config.payments.enabled}>
              {busy ? 'Opening secure checkout…' : `${timing === 'repeat' ? 'Pay first visit & set up' : 'Pay & request'}${estimate ? ` · ${money(estimate.totalCents)}` : ''}`}
            </button>
            <p className="hint center">
              🔒 Paid securely with Paystack. We hold your payment until the job is done, and you get a full refund if you cancel before work starts.
            </p>
            {!config.payments.enabled && <p className="error small center">Payments aren't set up on this server yet.</p>}
            {config.payments.testMode && (
              <p className="test-note small">
                <strong>Test mode:</strong> no real money moves. Pay with a{' '}
                <a href="https://paystack.com/docs/payments/test-payments/" target="_blank" rel="noreferrer">Paystack test card</a>.
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
