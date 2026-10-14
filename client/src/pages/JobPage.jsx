import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import FavouriteButton from '../components/FavouriteButton.jsx';
import { downloadFile } from '../api.js';
import { api } from '../api.js';
import Chat from '../components/Chat.jsx';
import PushPrompt from '../components/PushPrompt.jsx';
import ReportProblem from '../components/ReportProblem.jsx';
import EmergencyButton from '../components/EmergencySheet.jsx';
import ProPhoto, { vehicleText } from '../components/ProPhoto.jsx';
import MapView from '../components/MapView.jsx';
import StatusTimeline from '../components/StatusTimeline.jsx';
import { StarInput, Stars } from '../components/Stars.jsx';
import { PAYOUT_LABELS, STATUS_LABELS, currencySymbol, distanceKm, etaMinutes, goToCheckout, money, when } from '../format.js';
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
    case 'awaiting_payment': return 'Pay to send your request';
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

const CUSTOMER_PAYMENT = {
  paid: 'Paid ✓',
  refund_pending: 'Refund on its way',
  refunded: 'Refunded',
};

function cancelPrompt(job, proReleasing) {
  if (proReleasing) return 'Release this job so another pro can take it?';
  return job.paymentStatus === 'paid' ? 'Cancel this request? You will get a full refund to your card.' : 'Cancel this request?';
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

function CompletedActions({ job, onError }) {
  const navigate = useNavigate();
  const [favourites, setFavourites] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/favourites').then(setFavourites).catch(() => setFavourites([])); }, []);
  async function invoice() {
    setBusy(true);
    try {
      const { number } = await api(`/jobs/${job.id}/invoice`);
      await downloadFile(`/jobs/${job.id}/invoice.pdf`, `${number}.pdf`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card booking-actions">
      <button className="btn primary" onClick={() => navigate(`/?rebook=${job.id}`)}>↻ Book {job.provider.name.split(' ')[0]} again</button>
      {job.hasInvoice && <button className="btn" disabled={busy} onClick={invoice}>{busy ? 'Preparing…' : '⬇ Invoice (PDF)'}</button>}
      {favourites && <FavouriteButton pro={job.provider} saved={favourites.some((f) => f.id === job.provider.id)} onChange={setFavourites} />}
    </section>
  );
}

const starsText = (n) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;

/** Both sides rate each other after the job. Pros also see what the customer said about them. */
function Reviews({ job, isPro, busy, onRate }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const { mine, theirs, canReview } = job.reviews;
  const other = isPro ? job.customer.name.split(' ')[0] : job.provider.name.split(' ')[0];
  return (
    <section className="card">
      {canReview && (
        <>
          <h3>{isPro ? `How was ${other} to work for?` : `How did ${other} do?`}</h3>
          <p className="muted small">
            {isPro
              ? "Only our team sees what you write. Other pros just see the customer's average rating."
              : `Your rating and comment appear on ${other}'s profile with your first name.`}
          </p>
          <StarInput value={rating} onChange={setRating} />
          <textarea rows={2} maxLength={500} placeholder="Add a comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn primary block" disabled={!rating || busy} onClick={() => onRate({ rating, comment })}>Submit rating</button>
        </>
      )}
      {mine && (
        <div className="review-line">
          <h3>Your rating of {other}</h3>
          <p className="stars" aria-label={`${mine.rating} out of 5`}>{starsText(mine.rating)}</p>
          {mine.comment && <p className="muted">“{mine.comment}”</p>}
        </div>
      )}
      {theirs && (
        <div className="review-line">
          <h3>{other}'s rating of you</h3>
          <p className="stars" aria-label={`${theirs.rating} out of 5`}>{starsText(theirs.rating)}</p>
          {theirs.comment && <p className="muted">“{theirs.comment}”</p>}
        </div>
      )}
    </section>
  );
}

const ACTIVE_FOR_SHARE = ['requested', 'accepted', 'en_route', 'arrived', 'in_progress'];
// Matches the server: the emergency button stays for an hour after the job.
const recentlyCompleted = (job) => job.status === 'completed' && job.completedAt
  && Date.now() - new Date(`${job.completedAt.replace(' ', 'T')}Z`).getTime() < 60 * 60000;

/** "Share my job": a live link for family. Uses the phone's share sheet where there is one. */
function ShareJob({ job, onChange }) {
  const [link, setLink] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function share() {
    setBusy(true);
    setMessage('');
    try {
      const { url } = await api(`/jobs/${job.id}/share`, { method: 'POST' });
      setLink(url);
      onChange();
      const text = `Follow my ${job.category.name.toLowerCase()} job live on ProNow: who's coming, their vehicle and where they are.`;
      if (navigator.share) {
        await navigator.share({ title: 'My ProNow job', text, url }).catch(() => {});
      } else {
        await navigator.clipboard?.writeText(url).then(() => setMessage('Link copied. Paste it into a message to family.')).catch(() => {});
      }
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    await api(`/jobs/${job.id}/share`, { method: 'DELETE' });
    setLink('');
    setMessage('Sharing stopped. Any links you sent no longer work.');
    onChange();
  }

  return (
    <div className="share-job">
      <button className="btn" disabled={busy} onClick={share}>🔗 Share my job</button>
      {job.shareLinks > 0 && <button className="link small" onClick={stop}>Stop sharing</button>}
      {link && <input className="share-link" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Share link" />}
      {message && <p className="muted small">{message}</p>}
      {job.shareLinks > 0 && !link && !message && <p className="muted small">Shared with {job.shareLinks} link{job.shareLinks > 1 ? 's' : ''}. Links stop working when the job ends.</p>}
    </div>
  );
}

export default function JobPage() {
  const jobId = Number(useParams().id);
  const { user, socket } = useSession();
  const navigate = useNavigate();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [materials, setMaterials] = useState('');
  const [simulating, setSimulating] = useState(false);
  const [sharingGps, setSharingGps] = useState(false);
  const [params, setParams] = useSearchParams();
  // Paystack sends the customer back here with ?reference=... after checkout.
  const returnedFrom = useRef(params.get('reference'));
  const [paymentNotice, setPaymentNotice] = useState('');
  const isPro = user.role === 'provider';

  const load = useCallback(() => {
    api(`/jobs/${jobId}`)
      .then((j) => { setJob(j); setError(''); })
      .catch((e) => setError(e.status === 403 ? 'This job is no longer available.' : e.message));
  }, [jobId]);
  useEffect(() => {
    const reference = returnedFrom.current;
    if (!reference) return load();
    returnedFrom.current = null;
    setParams({}, { replace: true });
    setPaymentNotice('Checking your payment…');
    api(`/jobs/${jobId}/payment/confirm`, { method: 'POST', body: { reference } })
      .then((j) => {
        setJob(j);
        const unpaid = j.status === 'awaiting_payment' || j.materialsStatus === 'unpaid';
        setPaymentNotice(unpaid ? "Your payment didn't go through yet. You can try again below." : 'Payment received – thank you!');
      })
      .catch((e) => {
        setPaymentNotice('');
        setError(e.message);
        load();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useSocketEvent('job:updated', (j) => {
    if (j.id !== jobId) return;
    setJob(j);
    setPaymentNotice((n) => (n.startsWith('Checking') ? n : ''));
  });
  useSocketEvent('job:taken', ({ id }) => id === jobId && isPro && job?.status === 'requested' && load());
  // Confirmation messages fade after a few seconds; "checking" stays until the answer arrives.
  useEffect(() => {
    if (!paymentNotice || paymentNotice.startsWith('Checking')) return undefined;
    const t = setTimeout(() => setPaymentNotice(''), 6000);
    return () => clearTimeout(t);
  }, [paymentNotice]);

  useSocketEvent('payouts:updated', () => isPro && load());
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
    setPaymentNotice('');
    try {
      const result = await api(`/jobs/${jobId}${path}`, { method: 'POST', body });
      if (result.status === 'released') return navigate('/');
      if (result.authorizationUrl) return goToCheckout(result.authorizationUrl);
      setJob(result.job ?? result);
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
  const customerCanCancel = !isPro && ['awaiting_payment', 'requested', 'accepted', 'en_route'].includes(job.status);
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
          {job.status === 'requested' && !isPro && job.preferredProvider?.reservedUntil && (
            <p className="muted small">Asking {job.preferredProvider.name} first, as you requested.</p>
          )}
          {isPro && job.askedForYou && job.status === 'requested' && <p className="notice">⭐ This customer asked for you by name.</p>}
          {eta != null && <p className="eta">Arriving in about <strong>{eta} min</strong></p>}
          {(mine || !isPro) && (ASSIGNED.includes(job.status) || job.myEmergency || recentlyCompleted(job)) && (
            <div className="safety-row">
              {!isPro && ACTIVE_FOR_SHARE.includes(job.status) && <ShareJob job={job} onChange={load} />}
              <EmergencyButton job={job} onChange={load} />
            </div>
          )}
          {job.status === 'awaiting_payment' ? (
            <>
              <p className="muted">Your request goes out to nearby pros as soon as your payment clears. We hold it until the job is done.</p>
              <button className="btn primary lg block" disabled={busy} onClick={() => act('/payment')}>
                Pay {money(job.estimatedCents)} with Paystack
              </button>
            </>
          ) : (
            <StatusTimeline job={job} />
          )}
        </section>

        {paymentNotice && <p className="notice">{paymentNotice}</p>}
        {!isPro && ['requested', 'accepted', 'en_route'].includes(job.status) && (
          <PushPrompt message="Get a notification when your pro accepts and is on the way." />
        )}

        {!isPro && job.provider && (
          <section className="card person">
            <ProPhoto userId={job.provider.id} hasPhoto={job.provider.hasPhoto} name={job.provider.name} size={56} />
            <div className="grow">
              <Link to={`/pros/${job.provider.id}`} className="person-name">{job.provider.name}</Link>
              {job.provider.verified && <span className="verified" title="ID and trade documents checked by ProNow">✓ Verified</span>}
              <div><Stars value={job.provider.rating} count={job.provider.ratingCount} /></div>
              {job.provider.vehicle && ASSIGNED.includes(job.status) && <div className="vehicle small">🚐 {vehicleText(job.provider.vehicle)}</div>}
            </div>
            {job.provider.phone && ASSIGNED.includes(job.status) && <a className="btn" href={`tel:${job.provider.phone}`}>📞 Call</a>}
          </section>
        )}

        {mine && (
          <section className="card person">
            <div className="avatar">{job.customer.name[0]}</div>
            <div className="grow">
              <strong>{job.customer.name}</strong>
              <div className="small"><Stars value={job.customer.rating} count={job.customer.ratingCount} empty="New customer" /></div>
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
                {job.materialsCents > 0 && <><dt>Materials</dt><dd>{money(job.materialsCents)}</dd></>}
                <dt><strong>Total</strong></dt><dd><strong>{money(job.finalCents)}</strong></dd>
              </>
            )}
            {!isPro && job.paymentStatus && job.paymentStatus !== 'unpaid' && (
              <>
                <dt>Upfront payment</dt>
                <dd className={job.paymentStatus === 'paid' ? 'earn' : ''}>{CUSTOMER_PAYMENT[job.paymentStatus]}</dd>
              </>
            )}
            {!isPro && job.refundedCents > 0 && (
              <>
                <dt>Refunded</dt>
                <dd>{money(job.refundedCents)}</dd>
              </>
            )}
            {!isPro && job.materialsStatus && (
              <>
                <dt>Parts payment</dt>
                <dd className={job.materialsStatus === 'paid' ? 'earn' : ''}>{job.materialsStatus === 'paid' ? 'Paid ✓' : 'Needs your approval'}</dd>
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

        {mine && job.paymentStatus === 'paid' && job.status !== 'completed' && (
          <p className="notice">🔒 The customer has paid. Your payout is released when you mark the job complete.</p>
        )}

        {mine && job.payouts?.length > 0 && (
          <section className="card">
            <h3>Your payout</h3>
            {job.payouts.map((p, i) => (
              <div key={i} className="payout-row">
                <span>{p.kind === 'materials' ? 'Parts' : 'Job'} · {money(p.amountCents)}</span>
                <span className={`pill payout-${p.status}`}>{PAYOUT_LABELS[p.status]}</span>
                {p.failureReason && <span className="error small">{p.failureReason}</span>}
              </div>
            ))}
            {job.materialsStatus === 'unpaid' && <p className="muted small">Parts ({money(job.materialsCents)}) are paid out once the customer approves them.</p>}
            {job.payouts.some((p) => ['awaiting_details', 'failed'].includes(p.status)) && <Link to="/payouts" className="btn block">Manage payouts</Link>}
          </section>
        )}

        {!isPro && job.materialsStatus === 'unpaid' && (
          <section className="card highlight">
            <h3>Approve parts: {money(job.materialsCents)}</h3>
            <p className="muted small">{job.provider.name.split(' ')[0]} used parts or materials for this job. They're passed on at cost and go to your pro in full.</p>
            <button className="btn primary lg block" disabled={busy} onClick={() => act('/materials/payment')}>
              Pay {money(job.materialsCents)}
            </button>
          </section>
        )}

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
                <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={materials} onChange={(e) => setMaterials(e.target.value)} />
              </label>
            )}
            <button
              className="btn primary lg block"
              disabled={busy}
              onClick={() => act('/status', { status: next.status, materialsCents: Math.round(Number(materials || 0)) * 100 })}
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
            onClick={() => window.confirm(cancelPrompt(job, proCanRelease)) && act('/cancel')}
          >
            {proCanRelease ? 'Release job' : 'Cancel request'}
          </button>
        )}

        {job.reviews && (job.reviews.canReview || job.reviews.mine || job.reviews.theirs) && (
          <Reviews job={job} isPro={isPro} busy={busy} onRate={(body) => act('/rate', body)} />
        )}

        {!isPro && job.status === 'completed' && job.provider && (
          <CompletedActions job={job} onError={setError} />
        )}
        {job.recurringId && !isPro && (
          <p className="muted small">↻ Part of a repeat booking. <Link to="/history?tab=repeat">Manage it</Link></p>
        )}

        {(mine || (!isPro && job.provider)) && <ReportProblem job={job} onChange={setJob} />}

        {job.provider && (job.status !== 'requested') && (mine || !isPro) && (
          <Chat jobId={job.id} readOnly={!ASSIGNED.includes(job.status)} />
        )}
      </div>
    </div>
  );
}
