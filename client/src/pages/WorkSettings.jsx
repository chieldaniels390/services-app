import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import MapView, { circleBounds } from '../components/MapView.jsx';
import { useSession } from '../session.jsx';

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const PRESETS = {
  weekdays: { label: 'Weekdays 8-5', schedule: Object.fromEntries(DAYS.map(([d], i) => [d, i < 5 ? { start: '08:00', end: '17:00' } : null])) },
  everyday: { label: 'Every day 7-7', schedule: Object.fromEntries(DAYS.map(([d]) => [d, { start: '07:00', end: '19:00' }])) },
};

function useSaver(onSaved) {
  const [state, setState] = useState({ busy: false, error: '', saved: false });
  async function save(path, body) {
    setState({ busy: true, error: '', saved: false });
    try {
      const settings = await api(path, { method: 'PUT', body });
      onSaved(settings);
      setState({ busy: false, error: '', saved: true });
    } catch (e) {
      setState({ busy: false, error: e.message, saved: false });
    }
  }
  return [state, save];
}

function Trades({ settings, onSaved }) {
  const { categories, user } = useSession();
  const [selected, setSelected] = useState(settings.trades.map((t) => t.id));
  const [state, save] = useSaver(onSaved);
  const status = Object.fromEntries(settings.trades.map((t) => [t.id, t.status]));
  const changed = selected.join() !== settings.trades.map((t) => t.id).join();
  const verified = user.provider.verificationStatus === 'approved';
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <section className="card">
      <h3>Trades</h3>
      <p className="muted small">
        You get requests for every approved trade you list.{verified && ' New trades are checked by our team first, against your certificate.'}
      </p>
      <div className="chips">
        {categories.map((c) => (
          <button type="button" key={c.id} className={`chip ${selected.includes(c.id) ? 'on' : ''}`} aria-pressed={selected.includes(c.id)} onClick={() => toggle(c.id)}>
            {c.icon} {c.name}
            {status[c.id] === 'pending' && selected.includes(c.id) && verified && <span className="chip-note">awaiting approval</span>}
          </button>
        ))}
      </div>
      {state.error && <p className="error small">{state.error}</p>}
      {state.saved && !changed && <p className="saved small">Saved</p>}
      <button className="btn primary" disabled={!changed || state.busy || !selected.length} onClick={() => save('/provider/trades', { categories: selected })}>
        Save trades
      </button>
    </section>
  );
}

function Hours({ settings, onSaved }) {
  const [schedule, setSchedule] = useState(settings.workingHours);
  const [state, save] = useSaver(onSaved);
  const anyTime = schedule === null;
  const changed = JSON.stringify(schedule) !== JSON.stringify(settings.workingHours);

  const setDay = (day, value) => setSchedule((s) => ({ ...s, [day]: value }));
  return (
    <section className="card">
      <h3>Working hours</h3>
      <p className="muted small">
        While you're online, you only get requests for jobs inside these hours. For booked jobs, we check the booked time.
        {' '}Today: <strong>{settings.availability.hoursToday}</strong>.
      </p>
      <div className="segmented">
        <button type="button" className={anyTime ? 'on' : ''} onClick={() => setSchedule(null)}>Any time</button>
        <button type="button" className={!anyTime ? 'on' : ''} onClick={() => setSchedule(schedule ?? PRESETS.weekdays.schedule)}>Set my hours</button>
      </div>
      {!anyTime && (
        <>
          <div className="row wrap presets">
            <span className="muted small">Quick fill:</span>
            {Object.entries(PRESETS).map(([k, p]) => <button key={k} type="button" className="chip" onClick={() => setSchedule(p.schedule)}>{p.label}</button>)}
          </div>
          <div className="hours">
            {DAYS.map(([day, label]) => {
              const slot = schedule[day];
              const overnight = slot && slot.end <= slot.start;
              return (
                <div key={day} className={`hours-row ${slot ? '' : 'off'}`}>
                  <label className="radio">
                    <input type="checkbox" checked={!!slot} onChange={(e) => setDay(day, e.target.checked ? { start: '08:00', end: '17:00' } : null)} />
                    {label}
                  </label>
                  {slot ? (
                    <span className="times">
                      <input type="time" step="900" aria-label={`${label} start`} value={slot.start} onChange={(e) => setDay(day, { ...slot, start: e.target.value })} />
                      <span>to</span>
                      <input type="time" step="900" aria-label={`${label} end`} value={slot.end === '24:00' ? '00:00' : slot.end} onChange={(e) => setDay(day, { ...slot, end: e.target.value })} />
                      {overnight && <span className="hint">next day</span>}
                    </span>
                  ) : <span className="muted small">Off</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
      {state.error && <p className="error small">{state.error}</p>}
      {state.saved && !changed && <p className="saved small">Saved</p>}
      <button className="btn primary" disabled={!changed || state.busy} onClick={() => save('/provider/hours', { workingHours: schedule })}>Save hours</button>
    </section>
  );
}

function ServiceArea({ settings, onSaved }) {
  const { user, config } = useSession();
  const live = user.provider.location;
  const initial = settings.serviceArea ?? { ...(live ?? config.defaultCenter), radiusKm: settings.defaultRadiusKm };
  const [area, setArea] = useState(initial);
  const [state, save] = useSaver(onSaved);
  const changed = JSON.stringify(area) !== JSON.stringify(settings.serviceArea);

  function useMyLocation() {
    if (!navigator.geolocation) return live && setArea((a) => ({ ...a, ...live }));
    navigator.geolocation.getCurrentPosition(
      (p) => setArea((a) => ({ ...a, lat: p.coords.latitude, lng: p.coords.longitude })),
      () => live && setArea((a) => ({ ...a, ...live })),
      { timeout: 10000 },
    );
  }

  return (
    <section className="card">
      <h3>Service area</h3>
      <p className="muted small">
        Tap the map to set the centre, then choose how far you'll travel. You only get requests inside the circle.
        {!settings.serviceArea && ` Until you save one, it's ${settings.defaultRadiusKm} km around wherever you are.`}
      </p>
      <MapView
        className="area-map"
        center={area}
        markers={[{ id: 'centre', lat: area.lat, lng: area.lng, emoji: '📍', variant: 'home', label: 'Centre of your area' }]}
        circles={[{ id: 'area', ...area }]}
        frame={circleBounds(area)}
        onPick={(p) => setArea((a) => ({ ...a, ...p }))}
      />
      <label className="radius">
        <span>Travel up to <strong>{area.radiusKm} km</strong></span>
        <input type="range" min="1" max={settings.maxRadiusKm} step="1" value={area.radiusKm} onChange={(e) => setArea((a) => ({ ...a, radiusKm: Number(e.target.value) }))} />
      </label>
      {state.error && <p className="error small">{state.error}</p>}
      {state.saved && !changed && <p className="saved small">Saved</p>}
      <div className="row wrap">
        <button type="button" className="btn" onClick={useMyLocation}>📍 Centre on me</button>
        <button className="btn primary" disabled={!changed || state.busy} onClick={() => save('/provider/service-area', { serviceArea: area })}>Save area</button>
      </div>
    </section>
  );
}

export default function WorkSettings() {
  const { setUser } = useSession();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/provider/settings').then(setSettings).catch((e) => setError(e.message)); }, []);
  const onSaved = (next) => {
    setSettings(next);
    api('/me').then(setUser).catch(() => {});
  };

  if (!settings) return <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>;
  return (
    <div className="work-settings">
      <Link to="/" className="back-link">‹ Dashboard</Link>
      <h2>Work settings</h2>
      <Trades settings={settings} onSaved={onSaved} />
      <Hours settings={settings} onSaved={onSaved} />
      <ServiceArea settings={settings} onSaved={onSaved} />
    </div>
  );
}
