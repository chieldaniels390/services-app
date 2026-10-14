import { Link } from 'react-router-dom';
import { money } from '../../format.js';

export default function AdminOverview({ overview: o }) {
  if (!o) return <p className="muted">Loading…</p>;
  const todo = [
    o.pendingVerifications > 0 && { to: '/admin/pros', icon: '🪪', text: `${o.pendingVerifications} pro${o.pendingVerifications > 1 ? 's' : ''} waiting for verification` },
    o.openDisputes > 0 && { to: '/admin/disputes', icon: '⚠️', text: `${o.openDisputes} open dispute${o.openDisputes > 1 ? 's' : ''}` },
    o.lowRatedUsers > 0 && { to: '/admin/ratings', icon: '⭐', text: `${o.lowRatedUsers} ${o.lowRatedUsers > 1 ? 'users' : 'user'} rated below 3.5★` },
    o.payoutsNeedingAttention > 0 && { to: '/admin/jobs?status=completed', icon: '🏦', text: `${o.payoutsNeedingAttention} payout${o.payoutsNeedingAttention > 1 ? 's' : ''} failed or on hold` },
  ].filter(Boolean);
  return (
    <div className="admin-page">
      <h2>Overview</h2>
      <section className="card">
        <h3>Needs your attention</h3>
        {todo.length === 0 && <p className="muted">All clear. Nothing waiting on you.</p>}
        {todo.map((t) => (
          <Link key={t.to} to={t.to} className="todo-row"><span className="icon">{t.icon}</span><span className="grow">{t.text}</span><span>›</span></Link>
        ))}
      </section>
      <section className="stat-grid">
        <div><span className="muted small">Active jobs</span><strong>{o.activeJobs}</strong></div>
        <div><span className="muted small">Jobs today</span><strong>{o.jobsToday}</strong></div>
        <div><span className="muted small">Pros online</span><strong>{o.onlinePros}</strong></div>
        <div><span className="muted small">Collected (7 days)</span><strong>{money(o.collected7dCents)}</strong></div>
        <div><span className="muted small">Platform fees (7 days)</span><strong>{money(o.fees7dCents)}</strong></div>
      </section>
    </div>
  );
}
