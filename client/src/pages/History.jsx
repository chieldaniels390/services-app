import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { STATUS_LABELS, money, when } from '../format.js';
import { useSession } from '../session.jsx';

export default function History() {
  const { user, config } = useSession();
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState('');
  const isPro = user.role === 'provider';

  useEffect(() => {
    api('/jobs').then(setJobs).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!jobs) return <p className="muted">Loading…</p>;

  return (
    <div className="history">
      <h2>{isPro ? 'Your jobs' : 'Your bookings'}</h2>
      {jobs.length === 0 && (
        <p className="muted">Nothing here yet. {!isPro && <Link to="/">Book your first pro</Link>}</p>
      )}
      {jobs.map((j) => (
        <Link key={j.id} to={`/jobs/${j.id}`} className="card history-row">
          <span className="icon">{j.category.icon}</span>
          <div className="grow">
            <strong>{j.category.name}</strong>
            <div className="muted small">{when(j.createdAt)} · {isPro ? j.customer.name : j.provider?.name ?? 'No pro yet'}</div>
          </div>
          <div className="right">
            <strong>{money(isPro ? j.payoutCents : j.finalCents ?? j.estimatedCents, config.currency)}</strong>
            <span className={`pill status-${j.status}`}>{STATUS_LABELS[j.status]}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
