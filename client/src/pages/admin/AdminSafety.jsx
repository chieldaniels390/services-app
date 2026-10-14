import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { when } from '../../format.js';
import { useSocketEvent } from '../../session.jsx';

const STATUS = { open: 'Open', acknowledged: 'Being handled', resolved: 'Resolved', false_alarm: 'False alarm' };

export function AlertCard({ alert, onChange }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  async function handle(status) {
    setError('');
    try {
      await api(`/admin/emergencies/${alert.id}`, { method: 'POST', body: { status, note } });
      setNote('');
      onChange();
    } catch (e) {
      setError(e.message);
    }
  }
  const active = alert.status === 'open' || alert.status === 'acknowledged';
  return (
    <article className={`card alert-card ${alert.status}`}>
      <div className="row wrap">
        <strong className="grow">🆘 {alert.raisedBy.name} ({alert.role === 'provider' ? 'pro' : 'customer'}) · job #{alert.jobId}</strong>
        <span className={`pill alert-${alert.status}`}>{STATUS[alert.status]}</span>
      </div>
      <p className="muted small">{when(alert.createdAt)} · {alert.job.category.icon} {alert.job.category.name} · {alert.job.address}</p>
      {alert.note && <p>“{alert.note}”</p>}
      <dl className="kv">
        <dt>Raised by</dt><dd>{alert.raisedBy.phone ? <a href={`tel:${alert.raisedBy.phone}`}>{alert.raisedBy.phone}</a> : 'no phone'}</dd>
        <dt>Customer</dt><dd>{alert.customer.name} {alert.customer.phone && <a href={`tel:${alert.customer.phone}`}>{alert.customer.phone}</a>}</dd>
        <dt>Pro</dt><dd>{alert.provider ? <>{alert.provider.name} {alert.provider.phone && <a href={`tel:${alert.provider.phone}`}>{alert.provider.phone}</a>}</> : '–'}</dd>
        <dt>Location</dt>
        <dd>{alert.location
          ? <a target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${alert.location.lat},${alert.location.lng}`}>Open in maps ({alert.location.lat.toFixed(5)}, {alert.location.lng.toFixed(5)})</a>
          : 'Not shared'}</dd>
      </dl>
      {alert.handledNote && <p className="small"><strong>Notes:</strong> {alert.handledNote}{alert.handledBy && ` (${alert.handledBy})`}</p>}
      {active && (
        <>
          <textarea rows={2} placeholder="What happened / what you did" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row wrap">
            {alert.status === 'open' && <button className="btn primary" onClick={() => handle('acknowledged')}>I'm handling this</button>}
            <button className="btn" onClick={() => handle('resolved')}>Resolved</button>
            <button className="btn" onClick={() => handle('false_alarm')}>False alarm</button>
            <Link className="btn" to={`/admin/jobs/${alert.jobId}`}>Open job</Link>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </article>
  );
}

export default function AdminSafety({ onChange }) {
  const [filter, setFilter] = useState('open');
  const [alerts, setAlerts] = useState(null);
  const load = () => api(`/admin/emergencies${filter === 'open' ? '?status=open' : ''}`).then(setAlerts).catch(() => {});
  useEffect(() => { load(); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent('admin:updated', (e) => e.type === 'emergency' && load());
  const changed = () => { load(); onChange(); };

  return (
    <div className="admin-page">
      <h2>Safety</h2>
      <p className="muted small">Emergency button presses from customers and pros. Call the person first; if they're in danger, call 10111 for them.</p>
      <div className="filter-tabs">
        <button className={filter === 'open' ? 'on' : ''} onClick={() => setFilter('open')}>Open</button>
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
      </div>
      {alerts?.length === 0 && <p className="muted">{filter === 'open' ? 'No open alerts.' : 'No alerts yet.'}</p>}
      <div className="list">{alerts?.map((a) => <AlertCard key={a.id} alert={a} onChange={changed} />)}</div>
    </div>
  );
}
