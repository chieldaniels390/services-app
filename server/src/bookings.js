import { config } from './config.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { isValidPoint } from './geo.js';
import { ratingOf } from './jobs.js';
import { JOB_SIZES } from './pricing.js';
import { zonedTime } from './time.js';

const FREQUENCIES = { weekly: 'Every week', monthly: 'Every month' };
const fromSql = (v) => new Date(`${v.replace(' ', 'T')}Z`);
const toSql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

function localParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, Number(value)]));
  return p;
}

/** The visit after `visit`: same local time, a week later, or the same day next month (clamped to month end). */
export function nextVisit(visit, frequency, localTime, anchorDay) {
  const p = localParts(visit);
  const [hh, mm] = localTime.split(':').map(Number);
  if (frequency === 'weekly') return zonedTime(p.year, p.month, p.day + 7, hh, mm, config.timezone);
  const month = p.month === 12 ? 1 : p.month + 1;
  const year = p.month === 12 ? p.year + 1 : p.year;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return zonedTime(year, month, Math.min(anchorDay, lastDay), hh, mm, config.timezone);
}

const whenText = (date) => new Intl.DateTimeFormat('en-ZA', {
  timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(date);

/** Favourite pros and repeat bookings for customers. */
export function createBookingService({ db, jobs, notifier, now = () => new Date() }) {
  // --- Favourites --------------------------------------------------------

  function addFavourite(customer, providerId) {
    const ok = db.prepare(`SELECT 1 FROM jobs WHERE customer_id = ? AND provider_id = ? AND status = 'completed'`).get(customer.id, providerId);
    if (!ok) throw badRequest('You can save pros once they have done a job for you');
    db.prepare('INSERT OR IGNORE INTO favourites (customer_id, provider_id) VALUES (?, ?)').run(customer.id, providerId);
    return listFavourites(customer);
  }

  function removeFavourite(customer, providerId) {
    db.prepare('DELETE FROM favourites WHERE customer_id = ? AND provider_id = ?').run(customer.id, providerId);
    return listFavourites(customer);
  }

  function listFavourites(customer) {
    return db.prepare(`
      SELECT u.id, u.name, p.rating_sum, p.rating_count, p.verification_status,
        (SELECT GROUP_CONCAT(category_id) FROM provider_categories pc WHERE pc.user_id = u.id AND pc.status = 'approved') AS categories,
        (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = f.customer_id AND j.provider_id = u.id AND j.status = 'completed') AS jobsTogether,
        (SELECT MAX(completed_at) FROM jobs j WHERE j.customer_id = f.customer_id AND j.provider_id = u.id AND j.status = 'completed') AS lastJobAt,
        (SELECT j.id FROM jobs j WHERE j.customer_id = f.customer_id AND j.provider_id = u.id AND j.status = 'completed' ORDER BY j.completed_at DESC LIMIT 1) AS lastJobId
      FROM favourites f JOIN users u ON u.id = f.provider_id JOIN provider_profiles p ON p.user_id = u.id
      WHERE f.customer_id = ? ORDER BY f.created_at DESC`).all(customer.id)
      .map(({ rating_sum: sum, rating_count: count, verification_status: status, categories, ...pro }) => ({
        ...pro,
        rating: ratingOf(sum, count),
        ratingCount: count,
        verified: status === 'approved',
        categories: categories?.split(',') ?? [],
      }));
  }

  const favouriteIds = (customerId) => db.prepare('SELECT provider_id FROM favourites WHERE customer_id = ?').all(customerId).map((r) => r.provider_id);

  // --- Repeat bookings ---------------------------------------------------

  /**
   * Sets up a repeating booking and books the first visit straight away. The first visit is paid through
   * checkout (which saves the card); later visits are booked RECURRING_LEAD_HOURS ahead and charged to it.
   */
  async function createRecurring(customer, input) {
    const { categoryId, size, description, address, frequency, firstVisitAt, preferredProviderId } = input;
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (!FREQUENCIES[frequency]) throw badRequest('Choose how often: every week or every month');
    if (!JOB_SIZES[size]) throw badRequest('Unknown job size');
    if (!isValidPoint(lat, lng)) throw badRequest('A valid location is required');
    const first = new Date(firstVisitAt);
    if (Number.isNaN(first.getTime()) || first <= new Date(now().getTime() + 60 * 60000)) {
      throw badRequest('Pick a first visit at least an hour from now');
    }
    if (preferredProviderId) jobs.checkPreferred(customer.id, Number(preferredProviderId), categoryId);

    const p = localParts(first);
    const localTime = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO recurring_bookings (customer_id, preferred_provider_id, category_id, size, description, address, lat, lng,
        frequency, local_time, anchor_day, next_visit_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(customer.id, preferredProviderId ? Number(preferredProviderId) : null, categoryId, size, String(description ?? '').trim().slice(0, 1000),
        String(address ?? '').trim().slice(0, 300), lat, lng, frequency, localTime, p.day,
        toSql(nextVisit(first, frequency, localTime, p.day)));
    const id = Number(lastInsertRowid);
    try {
      const result = await jobs.create(customer, {
        categoryId, size, description, address, lat, lng, scheduledFor: first.toISOString(), preferredProviderId,
      }, { recurringId: id });
      return { recurring: getRecurring(customer, id), ...result };
    } catch (err) {
      db.prepare('DELETE FROM recurring_bookings WHERE id = ?').run(id);
      throw err;
    }
  }

  function toDto(row) {
    const upcoming = db.prepare(`
      SELECT id, status, scheduled_for AS scheduledFor, payment_status AS paymentStatus FROM jobs
      WHERE recurring_id = ? AND status NOT IN ('completed', 'cancelled') ORDER BY scheduled_for`).all(row.id);
    const category = db.prepare('SELECT name, icon FROM categories WHERE id = ?').get(row.category_id);
    const preferred = row.preferred_provider_id && db.prepare('SELECT name FROM users WHERE id = ?').get(row.preferred_provider_id);
    return {
      id: row.id,
      status: row.status,
      frequency: row.frequency,
      frequencyLabel: FREQUENCIES[row.frequency],
      localTime: row.local_time,
      category: { id: row.category_id, ...category },
      size: row.size,
      description: row.description,
      address: row.address,
      preferredProvider: preferred ? { id: row.preferred_provider_id, name: preferred.name } : null,
      nextVisitAt: row.status === 'active' ? fromSql(row.next_visit_at).toISOString() : null,
      upcomingJobs: upcoming,
      visitsCompleted: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE recurring_id = ? AND status = 'completed'").get(row.id).n,
    };
  }

  function requireOwn(customer, id) {
    const row = db.prepare('SELECT * FROM recurring_bookings WHERE id = ?').get(id);
    if (!row) throw notFound('Repeat booking not found');
    if (row.customer_id !== customer.id) throw forbidden();
    return row;
  }
  const getRecurring = (customer, id) => toDto(requireOwn(customer, id));

  function listRecurring(customer) {
    return db.prepare("SELECT * FROM recurring_bookings WHERE customer_id = ? AND status != 'cancelled' ORDER BY id DESC")
      .all(customer.id).map(toDto);
  }

  /** Pause, resume or cancel. Resuming skips any visits that fell in the pause. Booked visits stay booked. */
  function setRecurringStatus(customer, id, status) {
    const row = requireOwn(customer, id);
    if (!['active', 'paused', 'cancelled'].includes(status)) throw badRequest('Unknown status');
    if (row.status === 'cancelled') throw conflict('This repeat booking was cancelled');
    let next = fromSql(row.next_visit_at);
    if (status === 'active') {
      while (next <= now()) next = nextVisit(next, row.frequency, row.local_time, row.anchor_day);
    }
    db.prepare('UPDATE recurring_bookings SET status = ?, next_visit_at = ? WHERE id = ?').run(status, toSql(next), id);
    return toDto(db.prepare('SELECT * FROM recurring_bookings WHERE id = ?').get(id));
  }

  /** Skip the next visit that hasn't been booked yet. */
  function skipNext(customer, id) {
    const row = requireOwn(customer, id);
    if (row.status !== 'active') throw conflict('Only active repeat bookings can skip a visit');
    const next = nextVisit(fromSql(row.next_visit_at), row.frequency, row.local_time, row.anchor_day);
    db.prepare('UPDATE recurring_bookings SET next_visit_at = ? WHERE id = ?').run(toSql(next), id);
    return toDto(db.prepare('SELECT * FROM recurring_bookings WHERE id = ?').get(id));
  }

  /**
   * Books every visit that is now within the lead time. Each series is claimed by moving next_visit_at
   * forward first (a conditional update), so overlapping runs never book the same visit twice. Visits
   * missed while the server was down are skipped rather than booked in the past.
   */
  async function runDue() {
    const horizon = toSql(new Date(now().getTime() + config.recurringLeadHours * 3600000));
    const due = db.prepare("SELECT * FROM recurring_bookings WHERE status = 'active' AND next_visit_at <= ?").all(horizon);
    let booked = 0;
    for (const row of due) {
      let visit = fromSql(row.next_visit_at);
      while (visit <= now()) visit = nextVisit(visit, row.frequency, row.local_time, row.anchor_day);
      const following = nextVisit(visit, row.frequency, row.local_time, row.anchor_day);
      const { changes } = db.prepare('UPDATE recurring_bookings SET next_visit_at = ? WHERE id = ? AND next_visit_at = ?')
        .run(toSql(following), row.id, row.next_visit_at);
      if (!changes || visit > new Date(now().getTime() + config.recurringLeadHours * 3600000)) continue;

      const customer = db.prepare('SELECT id, role, name FROM users WHERE id = ?').get(row.customer_id);
      try {
        const { job, paid } = await jobs.create(customer, {
          categoryId: row.category_id, size: row.size, description: row.description, address: row.address,
          lat: row.lat, lng: row.lng, scheduledFor: visit.toISOString(),
          preferredProviderId: row.preferred_provider_id ?? undefined, payWithSavedCard: true,
        }, { recurringId: row.id });
        const jobRow = jobs.getJobRow(job.id);
        notifier.notify(customer.id, paid ? 'recurring_booked' : 'recurring_payment_needed', { job: jobRow, when: whenText(visit) });
        booked += 1;
      } catch (err) {
        // e.g. the preferred pro stopped offering the trade, or payments are down. Tell the customer, keep the series.
        console.error(`Repeat booking ${row.id}: could not book the visit on ${visit.toISOString()}:`, err.message);
      }
    }
    return booked;
  }

  return {
    addFavourite, removeFavourite, listFavourites, favouriteIds,
    createRecurring, listRecurring, getRecurring, setRecurringStatus, skipNext, runDue,
  };
}
