import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { money, when } from '../../format.js';
import { useSocketEvent } from '../../session.jsx';

export default function AdminDisputes() {
  const [status, setStatus] = useState('open');
  const [disputes, setDisputes] = useState(null);
  const [error, setError] = useState('');
  const load = () => api(`/admin/disputes?status=${status}`).then(setDisputes).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent('admin:updated', load);

  return (
    <div className="admin-page">
      <h2>Disputes</h2>
      <div className="filter-tabs">
        <button className={status === 'open' ? 'on' : ''} onClick={() => setStatus('open')}>Open</button>
        <button className={status === 'resolved' ? 'on' : ''} onClick={() => setStatus('resolved')}>Resolved</button>
      </div>
      {error && <p className="error">{error}</p>}
      {disputes?.length === 0 && <p className="muted">{status === 'open' ? 'No open disputes. 🎉' : 'Nothing resolved yet.'}</p>}
      <div className="list">
        {disputes?.map((d) => (
          <Link key={d.id} to={`/admin/jobs/${d.jobId}`} className="card list-row">
            <span className="icon">{d.categoryIcon}</span>
            <div className="grow">
              <strong>{d.reasonLabel}</strong> <span className="muted small">· job #{d.jobId} · {money(d.estimatedCents)}</span>
              <div className="small">{d.details || <span className="muted">No details given</span>}</div>
              <div className="muted small">
                Raised by {d.openedByName} ({d.openedByRole === 'provider' ? 'pro' : d.openedByRole}) · {when(d.createdAt)} · {d.customerName} ↔ {d.providerName ?? 'no pro'}
              </div>
            </div>
            <span>›</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
