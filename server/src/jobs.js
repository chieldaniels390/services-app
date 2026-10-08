import { config } from './config.js';
import { transaction } from './db.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { distanceKm, etaMinutes } from './geo.js';
import { createPaymentService } from './payments.js';
import { JOB_SIZES, quote, settle, surgeMultiplier } from './pricing.js';

export const ACTIVE_STATUSES = ['accepted', 'en_route', 'arrived', 'in_progress'];
const ACTIVE_SQL = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

// The only forward moves a pro can make on a job they own.
const NEXT_STATUS = {
  accepted: 'en_route',
  en_route: 'arrived',
  arrived: 'in_progress',
  in_progress: 'completed',
};

const JOB_SELECT = `
  SELECT j.*, c.name AS category_name, c.icon AS category_icon,
    cu.name AS customer_name, cu.phone AS customer_phone,
    pu.name AS provider_name, pu.phone AS provider_phone,
    pp.lat AS provider_lat, pp.lng AS provider_lng,
    pp.rating_sum AS provider_rating_sum, pp.rating_count AS provider_rating_count,
    r.rating, r.comment AS rating_comment
  FROM jobs j
  JOIN categories c ON c.id = j.category_id
  JOIN users cu ON cu.id = j.customer_id
  LEFT JOIN users pu ON pu.id = j.provider_id
  LEFT JOIN provider_profiles pp ON pp.user_id = j.provider_id
  LEFT JOIN ratings r ON r.job_id = j.id`;

export const ratingOf = (sum, count) => (count ? Math.round((sum / count) * 10) / 10 : null);

export function createJobService({ db, notify, paystack }) {
  const payments = createPaymentService({
    db,
    paystack,
    appUrl: config.appUrl,
    onBookingPaid: (id) => {
      const row = getJobRow(id);
      notifyParties(row);
      dispatch(row);
    },
    onJobChanged: (id) => notifyParties(getJobRow(id)),
    onPayoutChanged: (providerId) => notify(providerId, 'payouts:updated', {}),
  });
  const feeRateOf = (row) => row.fee_rate ?? config.platformFeeRate;

  const getCategory = (id) => db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  const getJobRow = (id) => db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id);

  function requireJob(id) {
    const row = getJobRow(id);
    if (!row) throw notFound('Job not found');
    return row;
  }

  function toDto(row, viewer) {
    const involved = viewer.id === row.customer_id || viewer.id === row.provider_id;
    const isProvider = viewer.role === 'provider';
    const trackProvider = row.provider_id && ACTIVE_STATUSES.includes(row.status) && row.provider_lat != null;
    const dto = {
      id: row.id,
      status: row.status,
      category: { id: row.category_id, name: row.category_name, icon: row.category_icon },
      description: row.description,
      size: row.size,
      sizeLabel: JOB_SIZES[row.size]?.label,
      // Pros browsing open requests only see a ~1km approximation until they accept.
      address: involved ? row.address : null,
      location: involved
        ? { lat: row.lat, lng: row.lng }
        : { lat: Math.round(row.lat * 100) / 100, lng: Math.round(row.lng * 100) / 100 },
      scheduledFor: row.scheduled_for,
      surge: row.surge,
      estimatedCents: row.estimated_cents,
      materialsCents: row.materials_cents,
      finalCents: row.final_cents,
      customer: {
        name: row.customer_name,
        phone: viewer.id === row.provider_id ? row.customer_phone : undefined,
      },
      provider: row.provider_id
        ? {
            id: row.provider_id,
            name: row.provider_name,
            phone: viewer.id === row.customer_id ? row.provider_phone : undefined,
            rating: ratingOf(row.provider_rating_sum, row.provider_rating_count),
            ratingCount: row.provider_rating_count,
            location: trackProvider ? { lat: row.provider_lat, lng: row.provider_lng } : null,
          }
        : null,
      review: row.rating ? { rating: row.rating, comment: row.rating_comment } : null,
      cancelledBy: row.cancelled_by,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
    };
    if (involved) {
      // paymentStatus: unpaid | paid | refund_pending | refunded. materialsStatus: null | unpaid | paid.
      dto.paymentStatus = row.payment_status;
      dto.materialsStatus = row.materials_status;
    }
    if (isProvider) {
      dto.payoutCents = row.payout_cents ?? settle(row.estimated_cents, 0, feeRateOf(row)).payoutCents;
    }
    if (isProvider && viewer.id === row.provider_id) {
      dto.payouts = db.prepare(`
        SELECT kind, amount_cents AS amountCents, status, failure_reason AS failureReason
        FROM payouts WHERE job_id = ? AND provider_id = ? ORDER BY id`).all(row.id, viewer.id);
    }
    return dto;
  }

  /** Online pros offering a category near a point, nearest first. Busy pros are excluded. */
  function availableProviders(categoryId, point, radiusKm = config.dispatchRadiusKm) {
    const rows = db.prepare(`
      SELECT u.id, u.name, p.lat, p.lng, p.rating_sum, p.rating_count
      FROM provider_profiles p
      JOIN users u ON u.id = p.user_id
      JOIN provider_categories pc ON pc.user_id = p.user_id AND pc.category_id = ?
      WHERE p.is_online = 1 AND p.lat IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.provider_id = p.user_id AND j.status IN (${ACTIVE_SQL}))`)
      .all(categoryId);
    return rows
      .map((r) => ({ ...r, distanceKm: distanceKm(point, r) }))
      .filter((r) => r.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  function openRequestsNear(categoryId, point) {
    return db.prepare(`SELECT lat, lng FROM jobs WHERE status = 'requested' AND category_id = ?`)
      .all(categoryId)
      .filter((j) => distanceKm(point, j) <= config.dispatchRadiusKm).length;
  }

  function estimate({ categoryId, size, lat, lng }) {
    const category = getCategory(categoryId);
    if (!category) throw badRequest('Unknown service category');
    if (!JOB_SIZES[size]) throw badRequest('Unknown job size');
    const point = { lat, lng };
    const providers = availableProviders(categoryId, point);
    const surge = surgeMultiplier(openRequestsNear(categoryId, point) + 1, providers.length);
    return {
      ...quote(category, size, surge),
      currency: config.currency,
      availableProviders: providers.length,
      etaMinutes: providers.length ? etaMinutes(providers[0].distanceKm) : null,
      nearby: providers.slice(0, 20).map((p) => ({
        // Jitter-free but rounded so exact pro positions are not exposed to anyone browsing.
        lat: Math.round(p.lat * 500) / 500,
        lng: Math.round(p.lng * 500) / 500,
        rating: ratingOf(p.rating_sum, p.rating_count),
      })),
    };
  }

  function dispatch(row) {
    const offered = availableProviders(row.category_id, row);
    for (const p of offered) {
      const dto = toDto(row, { id: p.id, role: 'provider' });
      notify(p.id, 'job:offer', { ...dto, distanceKm: round1(p.distanceKm), etaMinutes: etaMinutes(p.distanceKm) });
    }
    return offered.length;
  }

  /** Creates the job unpaid and returns a Paystack checkout link. Pros only see it once payment clears. */
  async function create(customer, input) {
    const { categoryId, size, description, address, lat, lng, scheduledFor } = input;
    const est = estimate({ categoryId, size, lat, lng });
    if (!description?.trim()) throw badRequest('Describe the problem so pros know what to bring');
    if (!address?.trim()) throw badRequest('Address is required');
    if (scheduledFor && Number.isNaN(Date.parse(scheduledFor))) throw badRequest('Invalid scheduled time');

    if (!payments.configured) throw new HttpError(503, 'Payments are not set up yet - add PAYSTACK_SECRET_KEY on the server');

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO jobs (customer_id, category_id, description, size, address, lat, lng, scheduled_for, surge, estimated_cents,
        status, fee_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?)`)
      .run(customer.id, categoryId, description.trim().slice(0, 1000), size, address.trim().slice(0, 300),
        lat, lng, scheduledFor ? new Date(scheduledFor).toISOString() : null, est.surge, est.totalCents, config.platformFeeRate);
    const id = Number(lastInsertRowid);
    let payment;
    try {
      payment = await payments.startBooking(id);
    } catch (err) {
      // No checkout, no booking: don't leave an orphaned job behind.
      db.prepare('DELETE FROM payments WHERE job_id = ?').run(id);
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
      throw err;
    }
    return { job: toDto(getJobRow(id), customer), payment };
  }

  function requireCustomerJob(customer, id) {
    const row = requireJob(id);
    if (row.customer_id !== customer.id) throw forbidden();
    return row;
  }

  /** A fresh checkout link for a booking that hasn't been paid yet. */
  async function payBooking(customer, id) {
    const row = requireCustomerJob(customer, id);
    if (row.status !== 'awaiting_payment') throw conflict('This booking is already paid');
    return payments.startBooking(id);
  }

  /** Called when the customer lands back from Paystack checkout (the webhook does the same server-side). */
  async function confirmPayment(customer, id, reference) {
    requireCustomerJob(customer, id);
    const payment = payments.getPayment(String(reference ?? ''));
    if (!payment || payment.job_id !== id) throw notFound('Payment not found');
    await payments.confirm(payment.reference);
    return toDto(getJobRow(id), customer);
  }

  async function payMaterials(customer, id) {
    requireCustomerJob(customer, id);
    const result = await payments.payMaterials(id);
    return { ...result, job: toDto(getJobRow(id), customer) };
  }

  function listForUser(user) {
    const column = user.role === 'provider' ? 'provider_id' : 'customer_id';
    return db.prepare(`${JOB_SELECT} WHERE j.${column} = ? ORDER BY j.id DESC LIMIT 100`)
      .all(user.id)
      .map((row) => toDto(row, user));
  }

  function getForUser(user, id) {
    const row = requireJob(id);
    const involved = user.id === row.customer_id || user.id === row.provider_id;
    const canPreview = user.role === 'provider' && row.status === 'requested' && offersCategory(user.id, row.category_id);
    if (!involved && !canPreview) throw forbidden();
    return toDto(row, user);
  }

  const offersCategory = (userId, categoryId) =>
    !!db.prepare('SELECT 1 FROM provider_categories WHERE user_id = ? AND category_id = ?').get(userId, categoryId);

  function openRequestsFor(provider) {
    const profile = db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(provider.id);
    if (!profile?.is_online || profile.lat == null) return [];
    return db.prepare(`${JOB_SELECT}
      WHERE j.status = 'requested' AND j.customer_id != ?
        AND j.category_id IN (SELECT category_id FROM provider_categories WHERE user_id = ?)
      ORDER BY j.id DESC`)
      .all(provider.id, provider.id)
      .map((row) => ({ row, km: distanceKm(profile, row) }))
      .filter(({ km }) => km <= config.dispatchRadiusKm)
      .sort((a, b) => a.km - b.km)
      .map(({ row, km }) => ({ ...toDto(row, provider), distanceKm: round1(km), etaMinutes: etaMinutes(km) }));
  }

  function notifyParties(row, event = 'job:updated') {
    for (const userId of [row.customer_id, row.provider_id]) {
      if (userId) notify(userId, event, toDto(row, { id: userId, role: userId === row.customer_id ? 'customer' : 'provider' }));
    }
  }

  function accept(provider, id) {
    const row = requireJob(id);
    if (!offersCategory(provider.id, row.category_id)) throw forbidden('You do not offer this service');
    if (row.customer_id === provider.id) throw forbidden();
    const busy = db.prepare(`SELECT 1 FROM jobs WHERE provider_id = ? AND status IN (${ACTIVE_SQL})`).get(provider.id);
    if (busy) throw conflict('Finish your current job before accepting another');

    // Conditional update makes "first pro to tap accept wins" atomic.
    const { changes } = db.prepare(`
      UPDATE jobs SET status = 'accepted', provider_id = ?, accepted_at = datetime('now')
      WHERE id = ? AND status = 'requested'`).run(provider.id, id);
    if (!changes) throw conflict('This job has already been taken');

    const updated = getJobRow(id);
    notifyParties(updated);
    notify.providers('job:taken', { id });
    return toDto(updated, provider);
  }

  async function advance(provider, id, { status, materialsCents = 0 }) {
    const row = requireJob(id);
    if (row.provider_id !== provider.id) throw forbidden();
    if (NEXT_STATUS[row.status] !== status) throw conflict(`Cannot move a job from ${row.status} to ${status}`);

    if (status === 'completed') {
      if (!Number.isInteger(materialsCents) || materialsCents < 0 || materialsCents > 1_000_000) {
        throw badRequest('Materials cost must be a non-negative amount');
      }
      const bill = settle(row.estimated_cents, materialsCents, feeRateOf(row));
      const { changes } = db.prepare(`
        UPDATE jobs SET status = 'completed', completed_at = datetime('now'), materials_cents = ?,
          final_cents = ?, platform_fee_cents = ?, payout_cents = ?, materials_status = ?
        WHERE id = ? AND status = 'in_progress'`)
        .run(materialsCents, bill.finalCents, bill.platformFeeCents, bill.payoutCents, materialsCents > 0 ? 'unpaid' : null, id);
      if (!changes) throw conflict('This job has already been completed');
      // Release the held booking money to the pro. Parts follow once the customer pays for them.
      if (row.payment_status === 'paid') {
        await payments.createPayout(row, 'labour', bill.payoutCents - materialsCents);
      }
    } else {
      const stamp = status === 'in_progress' ? ", started_at = datetime('now')" : '';
      db.prepare(`UPDATE jobs SET status = ?${stamp} WHERE id = ?`).run(status, id);
    }
    const updated = getJobRow(id);
    notifyParties(updated);
    return toDto(updated, provider);
  }

  async function cancel(user, id) {
    const row = requireJob(id);
    if (user.id === row.customer_id) {
      if (!['awaiting_payment', 'requested', 'accepted', 'en_route'].includes(row.status)) {
        throw conflict('This job can no longer be cancelled - talk to your pro');
      }
      // Refund first: if Paystack refuses, the job stays as it was and the customer can try again.
      if (row.payment_status === 'paid') await payments.refundBooking(id);
      db.prepare(`UPDATE jobs SET status = 'cancelled', cancelled_by = 'customer', cancelled_at = datetime('now') WHERE id = ?`).run(id);
      const updated = getJobRow(id);
      notifyParties(updated);
      if (row.status === 'requested') notify.providers('job:taken', { id });
      return toDto(updated, user);
    }
    if (user.id === row.provider_id) {
      if (!['accepted', 'en_route'].includes(row.status)) throw conflict('This job can no longer be cancelled');
      // A pro dropping out puts the job back on the market rather than failing the customer.
      db.prepare(`UPDATE jobs SET status = 'requested', provider_id = NULL, accepted_at = NULL WHERE id = ?`).run(id);
      notify(row.provider_id, 'job:released', { id });
      const requeued = getJobRow(id);
      notifyParties(requeued);
      dispatch(requeued);
      return { id, status: 'released' };
    }
    throw forbidden();
  }

  function rate(customer, id, { rating, comment = '' }) {
    const row = requireJob(id);
    if (row.customer_id !== customer.id) throw forbidden();
    if (row.status !== 'completed') throw conflict('You can rate a job once it is completed');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('Rating must be 1-5 stars');
    if (row.rating) throw conflict('You have already rated this job');
    transaction(db, () => {
      db.prepare('INSERT INTO ratings (job_id, rating, comment) VALUES (?, ?, ?)').run(id, rating, String(comment).slice(0, 500));
      db.prepare('UPDATE provider_profiles SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?')
        .run(rating, row.provider_id);
    });
    const updated = getJobRow(id);
    notifyParties(updated);
    return toDto(updated, customer);
  }

  function messages(user, id) {
    const row = requireJob(id);
    if (user.id !== row.customer_id && user.id !== row.provider_id) throw forbidden();
    return db.prepare(`
      SELECT m.id, m.body, m.created_at AS createdAt, m.sender_id AS senderId, u.name AS senderName
      FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.job_id = ? ORDER BY m.id`).all(id);
  }

  function sendMessage(user, id, body) {
    const row = requireJob(id);
    if (user.id !== row.customer_id && user.id !== row.provider_id) throw forbidden();
    if (!row.provider_id) throw conflict('Chat opens once a pro accepts the job');
    const text = String(body ?? '').trim().slice(0, 1000);
    if (!text) throw badRequest('Message is empty');
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (job_id, sender_id, body) VALUES (?, ?, ?)').run(id, user.id, text);
    const message = db.prepare(`
      SELECT m.id, m.body, m.created_at AS createdAt, m.sender_id AS senderId, u.name AS senderName, m.job_id AS jobId
      FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(Number(lastInsertRowid));
    notify(row.customer_id, 'message:new', message);
    notify(row.provider_id, 'message:new', message);
    return message;
  }

  /** Pushes a pro's position to the customer of their active job, if any. */
  function relayLocation(providerId, point) {
    const job = db.prepare(`SELECT id, customer_id FROM jobs WHERE provider_id = ? AND status IN (${ACTIVE_SQL})`).get(providerId);
    if (job) notify(job.customer_id, 'provider:location', { jobId: job.id, ...point });
  }

  function earnings(provider) {
    const sum = (where) => db.prepare(`
      SELECT COALESCE(SUM(payout_cents), 0) AS cents, COUNT(*) AS jobs
      FROM jobs WHERE provider_id = ? AND status = 'completed' ${where}`).get(provider.id);
    const payoutTotal = (statuses) => db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payouts
      WHERE provider_id = ? AND status IN (${statuses.map((s) => `'${s}'`).join(', ')})`).get(provider.id).cents;
    return {
      today: sum("AND completed_at >= datetime('now', 'start of day')"),
      week: sum("AND completed_at >= datetime('now', '-7 days')"),
      allTime: sum(''),
      paidOutCents: payoutTotal(['paid']),
      pendingPayoutCents: payoutTotal(['awaiting_details', 'sending', 'processing', 'failed']),
      currency: config.currency,
    };
  }

  return {
    estimate, create, listForUser, getForUser, openRequestsFor, accept, advance, cancel, rate,
    messages, sendMessage, relayLocation, earnings, payBooking, confirmPayment, payMaterials, payments,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
