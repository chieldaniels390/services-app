import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import MapView from '../components/MapView.jsx';
import ProPhoto, { vehicleText } from '../components/ProPhoto.jsx';
import { STATUS_LABELS, timeOnly, when } from '../format.js';

const POLL_MS = 5000;
const HEADLINES = {
  requested: 'Finding a pro',
  accepted: 'A pro has accepted the job',
  en_route: 'The pro is on the way',
  arrived: 'The pro has arrived',
  in_progress: 'Work is in progress',
};

/** Public page behind a "Share my job" link: no sign-in, refreshes itself, and goes quiet when the job ends. */
export default function Track() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const loaded = useRef(false);

  useEffect(() => {
    let timer;
    let stopped = false;
    async function load() {
      try {
        const res = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'This link is no longer active');
        setData(body);
        loaded.current = true;
        setError('');
        if (body.ended) return; // nothing more to follow
      } catch (e) {
        setError(e.message);
        // A dead link stops; a blip after it was working keeps retrying.
        if (!loaded.current) return;
      }
      if (!stopped) timer = setTimeout(load, POLL_MS);
    }
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token]);

  if (!data) {
    return (
      <div className="track">
        <section className="card center">
          {error ? <><h2>Link not active</h2><p className="muted">{error}. Ask for a new link if you still need to follow the job.</p></> : <p className="muted">Loading…</p>}
        </section>
      </div>
    );
  }

  const { provider, providerLocation } = data;
  const markers = [
    ...(data.destination ? [{ id: 'home', ...data.destination, emoji: '🏠', variant: 'home', label: `${data.customerFirstName}'s place` }] : []),
    ...(providerLocation ? [{ id: 'pro', ...providerLocation, emoji: '🚐', variant: 'pro', label: provider?.name }] : []),
  ];

  return (
    <div className="track">
      <section className="card">
        <p className="muted small">{data.customerFirstName} shared this {data.category.icon} {data.category.name.toLowerCase()} job with you</p>
        {data.ended ? (
          <>
            <h2>This job has {data.status === 'completed' ? 'finished' : 'been cancelled'}</h2>
            <p className="muted">{data.endedAt ? when(data.endedAt) : ''}. Live tracking has stopped.</p>
          </>
        ) : (
          <>
            <h2>{HEADLINES[data.status] ?? STATUS_LABELS[data.status]}</h2>
            {data.etaMinutes && <p className="eta">Arriving in about <strong>{data.etaMinutes} min</strong></p>}
            {data.scheduledFor && <p className="muted small">Booked for {when(data.scheduledFor)}</p>}
            {error && <p className="error small">Couldn't refresh: {error}</p>}
            <p className="muted small">Updated {timeOnly(data.updatedAt)} · refreshes automatically</p>
          </>
        )}
      </section>

      {!data.ended && provider && (
        <section className="card person">
          <ProPhoto name={provider.name} hasPhoto={provider.hasPhoto} src={provider.hasPhoto ? `/api/share/${encodeURIComponent(token)}/photo` : null} size={64} />
          <div className="grow">
            <strong>{provider.name}</strong>{provider.verified && <span className="verified">✓ ID verified</span>}
            {provider.rating && <div className="small"><span className="stars">★ {provider.rating}</span> <span className="muted">({provider.ratingCount})</span></div>}
            {provider.vehicle
              ? <div className="vehicle">🚐 {vehicleText(provider.vehicle)}</div>
              : <div className="muted small">No vehicle listed</div>}
          </div>
        </section>
      )}

      {!data.ended && markers.length > 0 && (
        <MapView className="track-map" center={providerLocation ?? data.destination} markers={markers} frame={[data.destination, providerLocation]} />
      )}

      <section className="card emergency-info">
        <h3>In an emergency</h3>
        <div className="sos-numbers">
          {data.emergencyNumbers.map((n) => (
            <a key={n.number} className="btn sos-call" href={`tel:${n.number}`}><strong>📞 {n.number}</strong><span>{n.label}</span></a>
          ))}
        </div>
      </section>
    </div>
  );
}
