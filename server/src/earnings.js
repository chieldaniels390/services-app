import { config } from './config.js';
import { localDate, periodStarts, toSqlTime, zonedTime } from './time.js';

const CHART_DAYS = 30;
const fromSql = (value) => new Date(`${value.replace(' ', 'T')}Z`);

// What the pro actually receives for a job: its payouts, minus any an admin cancelled in a dispute.
// Parts count once the customer has paid for them (that's when their payout is created).
const EARNED = `COALESCE((SELECT SUM(p.amount_cents) FROM payouts p WHERE p.job_id = j.id AND p.status != 'cancelled'), 0)`;

/** The pro earnings dashboard: period totals, a daily series, recent jobs and payouts. Periods are local time. */
export function createEarningsService({ db, now = () => new Date() }) {
  function totals(rows) {
    return rows.reduce((t, r) => ({
      earningsCents: t.earningsCents + r.earned,
      jobs: t.jobs + 1,
      feesCents: t.feesCents + (r.platform_fee_cents ?? 0),
      customerPaidCents: t.customerPaidCents + (r.final_cents ?? 0),
    }), { earningsCents: 0, jobs: 0, feesCents: 0, customerPaidCents: 0 });
  }

  function dashboard(providerId) {
    const at = now();
    const tz = config.timezone;
    const starts = periodStarts(at, tz);
    const [y, m, d] = localDate(at, tz).split('-').map(Number);
    const chartStart = zonedTime(y, m, d - (CHART_DAYS - 1), 0, 0, tz);
    const since = new Date(Math.min(chartStart, starts.month, starts.week));

    const rows = db.prepare(`
      SELECT j.id, j.completed_at, j.final_cents, j.platform_fee_cents, ${EARNED} AS earned
      FROM jobs j WHERE j.provider_id = ? AND j.status = 'completed' AND j.completed_at >= ?`)
      .all(providerId, toSqlTime(since))
      .map((r) => ({ ...r, at: fromSql(r.completed_at) }));
    const within = (start) => totals(rows.filter((r) => r.at >= start));

    const allTime = db.prepare(`
      SELECT COUNT(*) AS jobs, COALESCE(SUM(${EARNED}), 0) AS earningsCents,
        COALESCE(SUM(j.platform_fee_cents), 0) AS feesCents, COALESCE(SUM(j.final_cents), 0) AS customerPaidCents
      FROM jobs j WHERE j.provider_id = ? AND j.status = 'completed'`).get(providerId);

    // One entry per local day, oldest first, including days with nothing.
    const daily = Array.from({ length: CHART_DAYS }, (_, i) => {
      const date = localDate(zonedTime(y, m, d - (CHART_DAYS - 1) + i, 12, 0, tz), tz);
      const dayRows = rows.filter((r) => localDate(r.at, tz) === date);
      return { date, earningsCents: dayRows.reduce((s, r) => s + r.earned, 0), jobs: dayRows.length };
    });

    const recentJobs = db.prepare(`
      SELECT j.id, j.completed_at AS completedAt, c.name AS categoryName, c.icon AS categoryIcon, cu.name AS customerName,
        j.final_cents AS customerPaidCents, j.materials_cents AS partsCents, j.platform_fee_cents AS feeCents, ${EARNED} AS earningsCents,
        (SELECT GROUP_CONCAT(p.status) FROM payouts p WHERE p.job_id = j.id) AS payoutStatuses
      FROM jobs j JOIN categories c ON c.id = j.category_id JOIN users cu ON cu.id = j.customer_id
      WHERE j.provider_id = ? AND j.status = 'completed' ORDER BY j.completed_at DESC LIMIT 20`).all(providerId)
      .map(({ payoutStatuses, ...j }) => ({ ...j, payoutStatus: summarisePayouts(payoutStatuses) }));

    const payoutTotal = (statuses) => db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payouts
      WHERE provider_id = ? AND status IN (${statuses.map((s) => `'${s}'`).join(', ')})`).get(providerId).cents;

    return {
      timezone: tz,
      periods: { today: within(starts.today), week: within(starts.week), month: within(starts.month) },
      allTime,
      daily,
      recentJobs,
      payouts: {
        paidOutCents: payoutTotal(['paid']),
        pendingCents: payoutTotal(['awaiting_details', 'sending', 'processing', 'failed', 'on_hold']),
      },
      currency: config.currency,
    };
  }

  return { dashboard };
}

/** One status for a job's payouts, worst first, so problems aren't hidden behind a paid parts payout. */
function summarisePayouts(list) {
  if (!list) return 'none';
  const statuses = list.split(',');
  for (const s of ['failed', 'on_hold', 'awaiting_details', 'sending', 'processing', 'paid', 'cancelled']) {
    if (statuses.includes(s)) return s;
  }
  return statuses[0];
}
