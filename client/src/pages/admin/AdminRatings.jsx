import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { when } from '../../format.js';
import { useSocketEvent } from '../../session.jsx';

const starsText = (n) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;

/** Everyone whose average rating has dropped below the threshold. */
export default function AdminRatings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('/admin/flags').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useSocketEvent('admin:updated', (e) => e.type === 'rating' && load());

  if (!data) return <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>;
  return (
    <div className="admin-page">
      <h2>Low ratings</h2>
      <p className="muted small">
        Pros and customers averaging below {data.threshold}★ after at least {data.minReviews} reviews.
        For pros, open their profile to suspend them if needed. Customers' reviews come from pros and are only visible to admins.
      </p>
      {data.users.length === 0 && <p className="muted">Nobody is below {data.threshold}★ right now.</p>}
      <div className="list">
        {data.users.map((u) => (
          <article key={u.id} className="card flag-card">
            <div className="row">
              <div className="avatar">{u.name[0]}</div>
              <div className="grow">
                <strong>{u.name}</strong> <span className={`pill role-${u.role}`}>{u.role === 'provider' ? 'Pro' : 'Customer'}</span>
                {u.role === 'provider' && u.verificationStatus === 'rejected' && <span className="pill verify-rejected">Suspended</span>}
                <div className="muted small">{u.email} · last review {when(u.lastReviewAt)}</div>
              </div>
              <div className="right">
                <strong className="low-rating">{u.average}★</strong>
                <span className="muted small">{u.count} reviews · {u.lowCount} at 1-2★</span>
              </div>
            </div>
            <ul className="review-list compact">
              {u.recent.map((r) => (
                <li key={`${r.jobId}-${r.reviewerId}`}>
                  <span className="stars">{starsText(r.rating)}</span>{' '}
                  <span className="small">{r.comment || <span className="muted">No comment</span>}</span>
                  <span className="muted small"> · {r.reviewer}, <Link to={`/admin/jobs/${r.jobId}`}>job #{r.jobId}</Link></span>
                </li>
              ))}
            </ul>
            {u.role === 'provider' && <Link to={`/admin/pros/${u.id}`} className="btn">Review this pro ›</Link>}
          </article>
        ))}
      </div>
    </div>
  );
}
