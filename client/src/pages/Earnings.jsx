import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import EarningsChart from '../components/EarningsChart.jsx';
import { money, when } from '../format.js';
import { useSession, useSocketEvent } from '../session.jsx';

const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']];
// Short forms: these sit in a narrow column next to the amount.
const PAYOUT_SHORT = {
  paid: 'Paid', processing: 'On its way', sending: 'Sending', awaiting_details: 'Add bank details',
  failed: 'Failed', on_hold: 'On hold', cancelled: 'Cancelled',
};
const jobsText = (n) => `${n} ${n === 1 ? 'job' : 'jobs'}`;

export default function Earnings() {
  const { config } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api('/provider/earnings').then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useSocketEvent('payouts:updated', load);
  useSocketEvent('job:updated', load);

  if (!data) return <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>;
  const { periods, allTime, payouts } = data;
  return (
    <div className="earnings">
      <h2>Earnings</h2>

      <section className="stat-grid three">
        {PERIODS.map(([key, label]) => (
          <div key={key} className="stat-tile">
            <span className="muted small">{label}</span>
            <strong>{money(periods[key].earningsCents)}</strong>
            <span className="small">{jobsText(periods[key].jobs)} completed</span>
            <span className="muted small">{money(periods[key].feesCents)} platform fees</span>
          </div>
        ))}
      </section>
      <p className="muted small">
        All time: {money(allTime.earningsCents)} from {jobsText(allTime.jobs)} · {money(allTime.feesCents)} in platform fees.
        The fee is {Math.round(config.platformFeeRate * 100)}% of each job's upfront price; parts are passed on to you in full.
      </p>

      <EarningsChart daily={data.daily} />

      <section className="card">
        <div className="row">
          <h3 className="grow">Payouts</h3>
          <Link to="/payouts" className="small">Bank account & full history ›</Link>
        </div>
        <div className="stat-grid two-col">
          <div><span className="muted small">Paid to your bank</span><strong>{money(payouts.paidOutCents)}</strong></div>
          <div><span className="muted small">On the way or waiting</span><strong>{money(payouts.pendingCents)}</strong></div>
        </div>
      </section>

      <section className="card">
        <h3>Recent jobs</h3>
        {data.recentJobs.length === 0 && <p className="muted">No completed jobs yet. Go online to start earning.</p>}
        <ul className="job-earnings">
          {data.recentJobs.map((j) => (
            <li key={j.id}>
              <div className="grow">
                <Link to={`/jobs/${j.id}`}>{j.categoryIcon} {j.categoryName}</Link>
                <div className="muted small">{j.customerName} · {when(j.completedAt)}</div>
                <div className="muted small">
                  Customer paid {money(j.customerPaidCents)}{j.partsCents > 0 && ` (incl. ${money(j.partsCents)} parts)`} · fee −{money(j.feeCents ?? 0)}
                </div>
              </div>
              <div className="right">
                <strong>{money(j.earningsCents)}</strong>
                {j.payoutStatus !== 'none' && <span className={`pill payout-${j.payoutStatus}`}>{PAYOUT_SHORT[j.payoutStatus]}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
