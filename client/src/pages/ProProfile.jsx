import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { when } from '../format.js';
import { useSession } from '../session.jsx';

const starsText = (n) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;
const memberSince = (v) => new Date(`${v.replace(' ', 'T')}Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/** A pro's public profile: rating, jobs done and what customers said. */
export default function ProProfile() {
  const id = Number(useParams().id);
  const { categories, user } = useSession();
  const navigate = useNavigate();
  const [pro, setPro] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/pros/${id}`).then(setPro).catch((e) => setError(e.message)); }, [id]);

  if (!pro) return <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>;
  const most = Math.max(1, ...Object.values(pro.breakdown));
  const trade = (tid) => categories.find((c) => c.id === tid);

  return (
    <div className="pro-profile">
      <button className="link back" onClick={() => navigate(-1)}>‹ Back</button>
      <section className="card profile-head">
        <div className="avatar lg">{pro.name[0]}</div>
        <div className="grow">
          <h2>{pro.name} {pro.verified && <span className="verified">✓ Verified</span>}</h2>
          <p className="small">{pro.trades.map((t) => `${trade(t)?.icon} ${trade(t)?.name}`).join(' · ')}</p>
          <p className="muted small">On ProNow since {memberSince(pro.memberSince)}</p>
          {pro.bio && <p>“{pro.bio}”</p>}
        </div>
      </section>

      <section className="stat-grid three">
        <div className="stat-tile">
          <span className="muted small">Rating</span>
          <strong>{pro.rating ?? '–'}{pro.rating && <span className="stars small"> ★</span>}</strong>
          <span className="muted small">{pro.ratingCount} {pro.ratingCount === 1 ? 'review' : 'reviews'}</span>
        </div>
        <div className="stat-tile">
          <span className="muted small">Jobs completed</span>
          <strong>{pro.completedJobs}</strong>
          <span className="muted small">through ProNow</span>
        </div>
        <div className="stat-tile breakdown" aria-label="Ratings breakdown">
          {[5, 4, 3, 2, 1].map((n) => (
            <div key={n} className="breakdown-row">
              <span className="small">{n}★</span>
              <span className="breakdown-track"><span style={{ width: `${(pro.breakdown[n] / most) * 100}%` }} /></span>
              <span className="muted small">{pro.breakdown[n]}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Recent reviews</h3>
        {pro.recentReviews.length === 0 && <p className="muted">No reviews yet.</p>}
        <ul className="review-list">
          {pro.recentReviews.map((r, i) => (
            <li key={i}>
              <div className="row">
                <span className="stars" aria-label={`${r.rating} out of 5`}>{starsText(r.rating)}</span>
                <span className="muted small grow">{r.reviewer} · {r.categoryIcon} {r.categoryName}</span>
                <span className="muted small">{when(r.createdAt).split(',')[0]}</span>
              </div>
              {r.comment ? <p>{r.comment}</p> : <p className="muted small">No comment</p>}
            </li>
          ))}
        </ul>
      </section>

      {user.role === 'customer' && pro.workedWithYou && pro.trades.length > 0 && (
        <section className="card booking-actions">
          {pro.trades.map((t) => (
            <Link key={t} className="btn primary" to={`/?pro=${pro.id}&category=${t}`}>Book {pro.name.split(' ')[0]}: {trade(t)?.icon} {trade(t)?.name}</Link>
          ))}
        </section>
      )}
    </div>
  );
}
