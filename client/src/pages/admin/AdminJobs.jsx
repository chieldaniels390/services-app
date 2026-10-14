import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { STATUS_LABELS, money, when } from '../../format.js';

const FILTERS = [['', 'All'], ['active', 'Active'], ['disputed', 'Disputed'], ['awaiting_payment', 'Unpaid'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];

export default function AdminJobs() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ jobs: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { setPage(1); }, [status, q]);
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      const query = new URLSearchParams({ ...(status && { status }), ...(q && { q }), page: String(page) });
      api(`/admin/jobs?${query}`)
        .then((r) => setResult((prev) => (page === 1 ? r : { jobs: [...prev.jobs, ...r.jobs], hasMore: r.hasMore })))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, q, page]);

  return (
    <div className="admin-page">
      <h2>Jobs</h2>
      <div className="toolbar">
        <div className="filter-tabs">
          {FILTERS.map(([value, label]) => (
            <button key={label} className={status === value ? 'on' : ''} onClick={() => setParams(value ? { status: value } : {})}>{label}</button>
          ))}
        </div>
        <input type="search" placeholder="#id, name, email or address" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>Job</th><th>Customer</th><th>Pro</th><th>Created</th><th className="num">Amount</th><th>Status</th></tr>
          </thead>
          <tbody>
            {result.jobs.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/admin/jobs/${j.id}`}>#{j.id} {j.category.icon} {j.category.name}</Link></td>
                <td>{j.customerName}</td>
                <td>{j.providerName ?? <span className="muted">–</span>}</td>
                <td className="muted">{when(j.createdAt)}</td>
                <td className="num">{money(j.finalCents ?? j.estimatedCents)}</td>
                <td>
                  <span className={`pill status-${j.status}`}>{STATUS_LABELS[j.status]}</span>
                  {j.hasOpenDispute && <span className="pill dispute-pill">Disputed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && result.jobs.length === 0 && <p className="muted">No jobs match.</p>}
      {result.hasMore && <button className="btn block" disabled={loading} onClick={() => setPage((p) => p + 1)}>Load more</button>}
    </div>
  );
}
