import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Stars } from '../../components/Stars.jsx';
import { when } from '../../format.js';
import { useSession, useSocketEvent } from '../../session.jsx';

export const VERIFICATION_LABELS = { pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', unsubmitted: 'Not submitted' };
const FILTERS = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['unsubmitted', 'Not submitted'], ['', 'All']];

export default function AdminPros() {
  const { categories } = useSession();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'pending';
  const [q, setQ] = useState('');
  const [pros, setPros] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    const query = new URLSearchParams({ ...(status && { status }), ...(q && { q }) });
    api(`/admin/providers?${query}`).then(setPros).catch((e) => setError(e.message));
  };
  useEffect(load, [status, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useSocketEvent('admin:updated', load);

  const icons = (ids) => ids.map((id) => categories.find((c) => c.id === id)?.icon).join(' ');
  return (
    <div className="admin-page">
      <h2>Pros</h2>
      <div className="toolbar">
        <div className="filter-tabs">
          {FILTERS.map(([value, label]) => (
            <button key={label} className={status === value ? 'on' : ''} onClick={() => setParams(value ? { status: value } : { status: '' })}>{label}</button>
          ))}
        </div>
        <input type="search" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {pros?.length === 0 && <p className="muted">No pros here.</p>}
      <div className="list">
        {pros?.map((p) => (
          <Link key={p.id} to={`/admin/pros/${p.id}`} className="card list-row">
            <div className="avatar">{p.name[0]}</div>
            <div className="grow">
              <strong>{p.name}</strong> <span className="muted small">{icons(p.categories)}</span>
              <div className="muted small">{p.email} · joined {when(p.createdAt)}</div>
              {p.status === 'pending' && p.submittedAt && <div className="small">Submitted {when(p.submittedAt)}</div>}
            </div>
            <div className="right">
              <span className={`pill verify-${p.status}`}>{VERIFICATION_LABELS[p.status]}</span>
              {p.status === 'approved' && <Stars value={p.rating} count={p.ratingCount} />}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
