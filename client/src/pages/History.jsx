import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, downloadFile } from '../api.js';
import FavouriteButton from '../components/FavouriteButton.jsx';
import { Stars } from '../components/Stars.jsx';
import { ACTIVE_STATUSES, STATUS_LABELS, money, when } from '../format.js';
import { useSession } from '../session.jsx';

const TABS = [['bookings', 'Bookings'], ['favourites', 'Favourites'], ['repeat', 'Repeat']];
const FILTERS = [['all', 'All'], ['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];

function InvoiceButton({ job }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    setError('');
    try {
      const { number } = await api(`/jobs/${job.id}/invoice`);
      await downloadFile(`/jobs/${job.id}/invoice.pdf`, `${number}.pdf`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="btn" disabled={busy} onClick={download}>{busy ? 'Preparing…' : '⬇ Invoice'}</button>
      {error && <span className="error small block-line">{error}</span>}
    </>
  );
}

function Bookings({ jobs, favourites, setFavourites }) {
  const [filter, setFilter] = useState('all');
  const navigate = useNavigate();
  const saved = new Set(favourites.map((f) => f.id));
  const shown = jobs.filter((j) => filter === 'all'
    || (filter === 'active' ? ACTIVE_STATUSES.includes(j.status) : j.status === filter));

  return (
    <>
      <div className="filter-tabs">
        {FILTERS.map(([key, label]) => <button key={key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>{label}</button>)}
      </div>
      {shown.length === 0 && <p className="muted">{jobs.length ? 'Nothing here.' : <>No bookings yet. <Link to="/">Book your first pro</Link></>}</p>}
      {shown.map((j) => (
        <article key={j.id} className="card booking">
          <Link to={`/jobs/${j.id}`} className="booking-main">
            <span className="icon">{j.category.icon}</span>
            <div className="grow">
              <strong>{j.category.name}</strong>
              {j.recurringId && <span className="pill repeat-pill">Repeat</span>}
              <div className="muted small">{when(j.scheduledFor ?? j.completedAt ?? j.createdAt)}{j.provider ? ` · ${j.provider.name}` : ''}</div>
              <div className="muted small clamp">{j.description}</div>
            </div>
            <div className="right">
              <strong>{money(j.finalCents ?? j.estimatedCents)}</strong>
              <span className={`pill status-${j.status}`}>{STATUS_LABELS[j.status]}</span>
              {j.refundedCents > 0 && <span className="muted small">{money(j.refundedCents)} refunded</span>}
            </div>
          </Link>
          {j.status === 'completed' && j.provider && (
            <div className="booking-actions">
              {j.hasInvoice && <InvoiceButton job={j} />}
              <button className="btn primary" onClick={() => navigate(`/?rebook=${j.id}`)}>↻ Book again</button>
              <FavouriteButton pro={j.provider} saved={saved.has(j.provider.id)} onChange={setFavourites} />
            </div>
          )}
        </article>
      ))}
    </>
  );
}

function Favourites({ favourites, setFavourites }) {
  const { categories } = useSession();
  const navigate = useNavigate();
  if (!favourites.length) {
    return <p className="muted">No favourites yet. After a job, tap ♡ Save pro to book them again quickly.</p>;
  }
  return favourites.map((p) => (
    <article key={p.id} className="card fav-card">
      <div className="row">
        <div className="avatar">{p.name[0]}</div>
        <div className="grow">
          <strong>{p.name}</strong>{p.verified && <span className="verified">✓ Verified</span>}
          <div><Stars value={p.rating} count={p.ratingCount} /></div>
          <div className="muted small">{p.jobsTogether} {p.jobsTogether === 1 ? 'job' : 'jobs'} together · last {when(p.lastJobAt)}</div>
        </div>
        <FavouriteButton pro={p} saved onChange={setFavourites} compact />
      </div>
      <div className="booking-actions">
        {p.categories.map((id) => {
          const c = categories.find((x) => x.id === id);
          return <button key={id} className="btn" onClick={() => navigate(`/?pro=${p.id}&category=${id}`)}>Book {c?.icon} {c?.name}</button>;
        })}
        {p.categories.length === 0 && <span className="muted small">Not taking bookings right now.</span>}
      </div>
    </article>
  ));
}

function RepeatBookings({ items, reload }) {
  const [error, setError] = useState('');
  async function act(id, path, body, method = 'POST') {
    setError('');
    try {
      await api(`/recurring/${id}${path}`, { method, body });
      reload();
    } catch (e) {
      setError(e.message);
    }
  }
  if (!items.length) {
    return <p className="muted">No repeat bookings. When you book, choose <strong>Repeat</strong> to set up weekly or monthly visits, e.g. for a garden or pool.</p>;
  }
  return (
    <>
      {error && <p className="error">{error}</p>}
      {items.map((r) => (
        <article key={r.id} className={`card repeat ${r.status}`}>
          <div className="row">
            <span className="icon">{r.category.icon}</span>
            <div className="grow">
              <strong>{r.category.name}: {r.frequencyLabel.toLowerCase()} at {r.localTime}</strong>
              <div className="muted small">{r.address}{r.preferredProvider ? ` · with ${r.preferredProvider.name} first` : ''}</div>
              <div className="small">
                {r.status === 'paused' ? 'Paused' : <>Next visit to book: <strong>{when(r.nextVisitAt)}</strong></>}
                {' · '}{r.visitsCompleted} done
              </div>
            </div>
          </div>
          {r.upcomingJobs.length > 0 && (
            <div className="small upcoming">
              Booked: {r.upcomingJobs.map((j) => (
                <Link key={j.id} to={`/jobs/${j.id}`} className={j.status === 'awaiting_payment' ? 'needs-pay' : ''}>
                  {when(j.scheduledFor)}{j.status === 'awaiting_payment' ? ' (payment needed)' : ''}
                </Link>
              ))}
            </div>
          )}
          <div className="booking-actions">
            {r.status === 'active' && <button className="btn" onClick={() => act(r.id, '/skip')}>Skip next visit</button>}
            <button className="btn" onClick={() => act(r.id, '', { status: r.status === 'active' ? 'paused' : 'active' }, 'PATCH')}>
              {r.status === 'active' ? 'Pause' : 'Resume'}
            </button>
            <button className="btn danger" onClick={() => window.confirm('Stop this repeat booking? Visits already booked stay booked.') && act(r.id, '', { status: 'cancelled' }, 'PATCH')}>
              Stop repeating
            </button>
          </div>
        </article>
      ))}
    </>
  );
}

/** Pros: a simple list of their jobs. */
function ProJobs({ jobs }) {
  return jobs.length === 0 ? <p className="muted">Nothing here yet.</p> : jobs.map((j) => (
    <Link key={j.id} to={`/jobs/${j.id}`} className="card history-row">
      <span className="icon">{j.category.icon}</span>
      <div className="grow">
        <strong>{j.category.name}</strong>
        <div className="muted small">{when(j.createdAt)} · {j.customer.name}</div>
      </div>
      <div className="right">
        <strong>{money(j.payoutCents)}</strong>
        <span className={`pill status-${j.status}`}>{STATUS_LABELS[j.status]}</span>
      </div>
    </Link>
  ));
}

export default function History() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'bookings';
  const [jobs, setJobs] = useState(null);
  const [favourites, setFavourites] = useState([]);
  const [repeats, setRepeats] = useState([]);
  const [error, setError] = useState('');
  const isPro = user.role === 'provider';

  const loadRepeats = useCallback(() => api('/recurring').then(setRepeats).catch((e) => setError(e.message)), []);
  useEffect(() => {
    api('/jobs').then(setJobs).catch((e) => setError(e.message));
    if (!isPro) {
      api('/favourites').then(setFavourites).catch(() => {});
      loadRepeats();
    }
  }, [isPro, loadRepeats]);

  if (error) return <p className="error">{error}</p>;
  if (!jobs) return <p className="muted">Loading…</p>;
  if (isPro) {
    return <div className="history"><h2>Your jobs</h2><ProJobs jobs={jobs} /></div>;
  }
  return (
    <div className="history">
      <h2>Your bookings</h2>
      <nav className="admin-tabs sub-tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setParams(key === 'bookings' ? {} : { tab: key })}>
            {label}
            {key === 'favourites' && favourites.length > 0 && <span className="muted"> {favourites.length}</span>}
            {key === 'repeat' && repeats.length > 0 && <span className="muted"> {repeats.length}</span>}
          </button>
        ))}
      </nav>
      {tab === 'bookings' && <Bookings jobs={jobs} favourites={favourites} setFavourites={setFavourites} />}
      {tab === 'favourites' && <Favourites favourites={favourites} setFavourites={setFavourites} />}
      {tab === 'repeat' && <RepeatBookings items={repeats} reload={loadRepeats} />}
    </div>
  );
}
