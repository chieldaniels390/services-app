import { config } from './config.js';
import { transaction } from './db.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { distanceKm, etaMinutes } from './geo.js';
import { DISPUTE_REASONS, createDisputeService } from './disputes.js';
import { createPaymentService } from './payments.js';
import { createReviewService } from './reviews.js';
import { isWithinHours } from './time.js';
import { JOB_SIZES, quote, settle, surgeMultiplier, toWholeRand } from './pricing.js';

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
    pp.verification_status AS provider_verification, pp.photo_file AS provider_photo,
    pp.vehicle_make, pp.vehicle_model, pp.vehicle_colour, pp.vehicle_plate
  FROM jobs j
  JOIN categories c ON c.id = j.category_id
  JOIN users cu ON cu.id = j.customer_id
  LEFT JOIN users pu ON pu.id = j.provider_id
  LEFT JOIN provider_profiles pp ON pp.user_id = j.provider_id`;

export const ratingOf = (sum, count) => (count ? Math.round((sum / count) * 10) / 10 : null);

const silentNotifier = { notify: () => {} };

export const parseSchedule = (json) => (json ? JSON.parse(json) : null);

/**
 * Does this pro cover a job at this place and time? The service area is the centre the pro picked
 * (falling back to their live location) and their radius (falling back to DISPATCH_RADIUS_KM).
 */
export function coversJob(profile, point, at) {
  const center = profile.service_lat != null
    ? { lat: profile.service_lat, lng: profile.service_lng }
    : profile.lat != null ? { lat: profile.lat, lng: profile.lng } : null;
  if (!center) return false;
  const radiusKm = profile.service_radius_km ?? config.dispatchRadiusKm;
  return distanceKm(center, point) <= radiusKm && isWithinHours(parseSchedule(profile.working_hours), at, config.timezone);
}

export function createJobService({
  db, notify, paystack, notifyAdmins = () => {}, notifier = silentNotifier, now = () => new Date(),
}) {
  const fromSql = (v) => new Date(`${v.replace(' ', 'T')}Z`);
  const toSql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

  /** Is a "book again" job still reserved for the customer's chosen pro? */
  const reservedFor = (row) => (row.preferred_provider_id && !row.preferred_released && row.preferred_until
    && fromSql(row.preferred_until) > now() ? row.preferred_provider_id : null);

  // Scheduled jobs are matched against the pro's hours at the booked time, not when the request was made.
  const jobTime = (row) => (row.scheduled_for ? new Date(row.scheduled_for) : now());
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
    onPayoutPaid: (payout) => notifier.notify(payout.provider_id, 'payout_paid', { amountCents: payout.amount_cents, jobId: payout.job_id }),
    onRefund: (jobId, amountCents) => {
      const job = getJobRow(jobId);
      notifier.notify(job.customer_id, 'refund_issued', { job, amountCents });
    },
  });
  const reviews = createReviewService({ db, notifier, notifyAdmins, now });
  const disputes = createDisputeService({
    db, payments, notifyAdmins, onJobChanged: (id) => notifyParties(getJobRow(id)),
    onOpened: (jobId, openedBy) => {
      const job = getJobRow(jobId);
      for (const userId of [job.customer_id, job.provider_id]) if (userId !== openedBy) notifier.notify(userId, 'dispute_opened', { job });
    },
    onResolved: (jobId, note) => {
      const job = getJobRow(jobId);
      for (const userId of [job.customer_id, job.provider_id]) notifier.notify(userId, 'dispute_resolved', { job, note });
    },
  });
  const isApproved = (userId) =>
    db.prepare('SELECT verification_status FROM provider_profiles WHERE user_id = ?').get(userId)?.verification_status === 'approved';
  const feeRateOf = (row) => row.fee_rate ?? config.platformFeeRate;

  const getCategory = (id) => db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  const getJobRow = (id) => db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id);

  function requireJob(id) {
    const row = getJobRow(id);
    if (!row) throw notFound('Job not found');
    return row;
  }

  function latestDispute(jobId) {
    const d = db.prepare(`
      SELECT d.*, u.role AS opener_role FROM disputes d JOIN users u ON u.id = d.opened_by
      WHERE d.job_id = ? ORDER BY d.id DESC`).get(jobId);
    if (!d) return null;
    return {
      id: d.id, status: d.status, reason: d.reason, reasonLabel: DISPUTE_REASONS[d.reason], details: d.details,
      openedBy: d.opener_role, resolutionNote: d.resolution_note, refundCents: d.refund_cents,
      payoutAction: d.payout_action, createdAt: d.created_at, resolvedAt: d.resolved_at,
    };
  }

  function toDto(row, viewer) {
    const involved = viewer.id === row.customer_id || viewer.id === row.provider_id || viewer.role === 'admin';
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
        // Pros (and admins) see how other pros have rated this customer.
        ...(isProvider || viewer.role === 'admin' ? reviews.summary(row.customer_id) : {}),
      },
      provider: row.provider_id
        ? {
            id: row.provider_id,
            name: row.provider_name,
            phone: viewer.id === row.customer_id ? row.provider_phone : undefined,
            rating: ratingOf(row.provider_rating_sum, row.provider_rating_count),
            ratingCount: row.provider_rating_count,
            location: trackProvider ? { lat: row.provider_lat, lng: row.provider_lng } : null,
            verified: row.provider_verification === 'approved',
            hasPhoto: Boolean(row.provider_photo),
            // So the customer knows who and what to expect at the door.
            vehicle: involved && (row.vehicle_plate || row.vehicle_make)
              ? { make: row.vehicle_make, model: row.vehicle_model, colour: row.vehicle_colour, plate: row.vehicle_plate }
              : undefined,
          }
        : null,
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
      dto.refundedCents = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM refunds WHERE job_id = ?').get(row.id).c;
      dto.dispute = latestDispute(row.id);
    }
    if (isProvider) {
      dto.payoutCents = row.payout_cents ?? settle(row.estimated_cents, 0, feeRateOf(row)).payoutCents;
      dto.askedForYou = row.preferred_provider_id === viewer.id && !row.preferred_released;
    }
    if (involved && row.preferred_provider_id) {
      const name = db.prepare('SELECT name FROM users WHERE id = ?').get(row.preferred_provider_id)?.name;
      dto.preferredProvider = { id: row.preferred_provider_id, name, reservedUntil: reservedFor(row) ? row.preferred_until : null };
    }
    if (involved && viewer.role !== 'admin') dto.reviews = reviews.forJob(viewer, row);
    if (involved) {
      dto.recurringId = row.recurring_id;
      dto.hasInvoice = row.status === 'completed' && row.payment_status !== 'unpaid';
    }
    if (isProvider && viewer.id === row.provider_id) {
      dto.payouts = db.prepare(`
        SELECT kind, amount_cents AS amountCents, status, failure_reason AS failureReason
        FROM payouts WHERE job_id = ? AND provider_id = ? ORDER BY id`).all(row.id, viewer.id);
    }
    return dto;
  }

  /** Online pros offering a category near a point, nearest first. Busy pros are excluded. */
  /** Pros who would be offered a job for this trade, place and time: online, approved, free, in range and on shift. Nearest first. */
  function availableProviders(categoryId, point, at = now()) {
    const rows = db.prepare(`
      SELECT u.id, u.name, p.*
      FROM provider_profiles p
      JOIN users u ON u.id = p.user_id
      JOIN provider_categories pc ON pc.user_id = p.user_id AND pc.category_id = ? AND pc.status = 'approved'
      WHERE p.is_online = 1 AND p.lat IS NOT NULL
        AND p.verification_status = 'approved'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.provider_id = p.user_id AND j.status IN (${ACTIVE_SQL}))`)
      .all(categoryId);
    return rows
      .filter((r) => coversJob(r, point, at))
      .map((r) => ({ ...r, distanceKm: distanceKm(point, r) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  function openRequestsNear(categoryId, point) {
    return db.prepare(`SELECT lat, lng FROM jobs WHERE status = 'requested' AND category_id = ?`)
      .all(categoryId)
      .filter((j) => distanceKm(point, j) <= config.dispatchRadiusKm).length;
  }

  function estimate({ categoryId, size, lat, lng, scheduledFor }) {
    const category = getCategory(categoryId);
    if (!category) throw badRequest('Unknown service category');
    if (!JOB_SIZES[size]) throw badRequest('Unknown job size');
    const point = { lat, lng };
    const at = scheduledFor && !Number.isNaN(Date.parse(scheduledFor)) ? new Date(scheduledFor) : now();
    const providers = availableProviders(categoryId, point, at);
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

  function offer(row, p, type = 'new_offer') {
    const dto = toDto(row, { id: p.id, role: 'provider' });
    notify(p.id, 'job:offer', { ...dto, distanceKm: round1(p.distanceKm), etaMinutes: etaMinutes(p.distanceKm) });
    notifier.notify(p.id, type, { job: row, distanceKm: round1(p.distanceKm), payoutCents: dto.payoutCents });
  }

  /**
   * Offers a requested job to pros. A "book again" job goes to the chosen pro alone first (if they're
   * available); everyone else gets it when the window ends (releaseExpiredPreferences) or straight away
   * if the chosen pro can't take it.
   */
  function dispatch(row) {
    const offered = availableProviders(row.category_id, row, jobTime(row));
    if (row.preferred_provider_id && !row.preferred_released) {
      const chosen = offered.find((p) => p.id === row.preferred_provider_id);
      if (chosen) {
        const minutes = row.scheduled_for ? config.preferredWindowScheduledMinutes : config.preferredWindowMinutes;
        db.prepare('UPDATE jobs SET preferred_until = ? WHERE id = ?').run(toSql(new Date(now().getTime() + minutes * 60000)), row.id);
        offer(getJobRow(row.id), chosen, 'rebook_offer');
        return 1;
      }
      db.prepare('UPDATE jobs SET preferred_released = 1 WHERE id = ?').run(row.id);
      notifier.notify(row.customer_id, 'preferred_unavailable', { job: row });
    }
    for (const p of offered) offer(row, p);
    return offered.length;
  }

  /** Sends "book again" jobs to everyone once the chosen pro's window has passed. Run periodically. */
  function releaseExpiredPreferences() {
    const due = db.prepare(`
      SELECT id FROM jobs WHERE status = 'requested' AND preferred_provider_id IS NOT NULL AND preferred_released = 0
        AND preferred_until IS NOT NULL AND preferred_until <= ?`).all(toSql(now()));
    for (const { id } of due) {
      const { changes } = db.prepare('UPDATE jobs SET preferred_released = 1 WHERE id = ? AND preferred_released = 0').run(id);
      if (!changes) continue;
      const row = getJobRow(id);
      notifier.notify(row.customer_id, 'preferred_unavailable', { job: row });
      dispatch(row);
    }
    return due.length;
  }

  /** The pro a customer wants to rebook: someone who has completed a job for them and offers this trade. */
  function checkPreferred(customerId, providerId, categoryId) {
    const pro = db.prepare(`
      SELECT u.id, u.name FROM users u WHERE u.id = ? AND u.role = 'provider'
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.customer_id = ? AND j.provider_id = u.id AND j.status = 'completed')`)
      .get(providerId, customerId);
    if (!pro) throw badRequest('You can only rebook pros who have done a job for you');
    if (!offersCategory(providerId, categoryId)) throw badRequest(`${pro.name.split(' ')[0]} doesn't offer this service`);
    return pro;
  }

  /** For the booking form: is the chosen pro available for this job right now (or at the booked time)? */
  function preferredInfo(customer, { preferredProviderId, categoryId, lat, lng, scheduledFor }) {
    const pro = checkPreferred(customer.id, Number(preferredProviderId), categoryId);
    const at = scheduledFor && !Number.isNaN(Date.parse(scheduledFor)) ? new Date(scheduledFor) : now();
    return { id: pro.id, name: pro.name, available: availableProviders(categoryId, { lat, lng }, at).some((p) => p.id === pro.id) };
  }

  /** Creates the job unpaid and returns a Paystack checkout link. Pros only see it once payment clears. */
  async function create(customer, input, { recurringId = null } = {}) {
    const { categoryId, size, description, address, lat, lng, scheduledFor } = input;
    // Repeat visits are charged automatically, so they always use the standard rate, never busy-time pricing.
    const est = recurringId
      ? { ...estimate({ categoryId, size, lat, lng, scheduledFor }), ...quote(getCategory(categoryId), size, 1) }
      : estimate({ categoryId, size, lat, lng, scheduledFor });
    const preferred = input.preferredProviderId ? checkPreferred(customer.id, Number(input.preferredProviderId), categoryId) : null;
    if (!description?.trim()) throw badRequest('Describe the problem so pros know what to bring');
    if (!address?.trim()) throw badRequest('Address is required');
    if (scheduledFor && Number.isNaN(Date.parse(scheduledFor))) throw badRequest('Invalid scheduled time');

    if (!payments.configured) throw new HttpError(503, 'Payments are not set up yet - add PAYSTACK_SECRET_KEY on the server');

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO jobs (customer_id, category_id, description, size, address, lat, lng, scheduled_for, surge, estimated_cents,
        status, fee_rate, preferred_provider_id, recurring_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?)`)
      .run(customer.id, categoryId, description.trim().slice(0, 1000), size, address.trim().slice(0, 300),
        lat, lng, scheduledFor ? new Date(scheduledFor).toISOString() : null, est.surge, est.totalCents, config.platformFeeRate,
        preferred?.id ?? null, recurringId);
    const id = Number(lastInsertRowid);
    if (input.payWithSavedCard) {
      // Repeat bookings: charge the saved card. If that fails the job waits for the customer to pay.
      const paid = await payments.payBookingWithSavedCard(id);
      return { job: toDto(getJobRow(id), customer), paid };
    }
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
    // Most recent first: by when the job finished, or when it was booked if it hasn't yet.
    return db.prepare(`${JOB_SELECT} WHERE j.${column} = ? ORDER BY COALESCE(j.completed_at, j.cancelled_at, j.created_at) DESC, j.id DESC LIMIT 100`)
      .all(user.id)
      .map((row) => toDto(row, user));
  }

  function getForUser(user, id) {
    const row = requireJob(id);
    const involved = user.id === row.customer_id || user.id === row.provider_id;
    const canPreview = user.role === 'provider' && row.status === 'requested' && offersCategory(user.id, row.category_id)
      && isApproved(user.id);
    if (!involved && !canPreview && user.role !== 'admin') throw forbidden();
    return toDto(row, user);
  }

  // Only approved trades count: one added after verification waits for an admin to check it.
  const offersCategory = (userId, categoryId) =>
    !!db.prepare("SELECT 1 FROM provider_categories WHERE user_id = ? AND category_id = ? AND status = 'approved'").get(userId, categoryId);

  function openRequestsFor(provider) {
    const profile = db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(provider.id);
    if (!profile?.is_online || profile.lat == null || profile.verification_status !== 'approved') return [];
    return db.prepare(`${JOB_SELECT}
      WHERE j.status = 'requested' AND j.customer_id != ?
        AND j.category_id IN (SELECT category_id FROM provider_categories WHERE user_id = ? AND status = 'approved')
      ORDER BY j.id DESC`)
      .all(provider.id, provider.id)
      .filter((row) => coversJob(profile, row, jobTime(row)))
      .filter((row) => !reservedFor(row) || reservedFor(row) === provider.id)
      .map((row) => ({ row, km: distanceKm(profile, row) }))
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
    if (!isApproved(provider.id)) throw forbidden('Your account needs to be verified before you can take jobs');
    if (!offersCategory(provider.id, row.category_id)) throw forbidden('You do not offer this service');
    if (row.customer_id === provider.id) throw forbidden();
    const busy = db.prepare(`SELECT 1 FROM jobs WHERE provider_id = ? AND status IN (${ACTIVE_SQL})`).get(provider.id);
    if (busy) throw conflict('Finish your current job before accepting another');
    const reserved = reservedFor(row);
    if (reserved && reserved !== provider.id) throw conflict('The customer asked for another pro first. It may come back to you in a few minutes.');

    // Conditional update makes "first pro to tap accept wins" atomic.
    const { changes } = db.prepare(`
      UPDATE jobs SET status = 'accepted', provider_id = ?, accepted_at = datetime('now')
      WHERE id = ? AND status = 'requested'`).run(provider.id, id);
    if (!changes) throw conflict('This job has already been taken');

    const updated = getJobRow(id);
    notifyParties(updated);
    notify.providers('job:taken', { id });
    notifier.notify(updated.customer_id, 'job_accepted', { job: updated });
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
      materialsCents = toWholeRand(materialsCents); // whole rands, like every other price
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
    const event = { en_route: 'pro_en_route', arrived: 'pro_arrived', completed: 'job_completed' }[status];
    if (event) {
      const from = updated.provider_lat != null ? { lat: updated.provider_lat, lng: updated.provider_lng } : null;
      notifier.notify(updated.customer_id, event, { job: updated, eta: from ? etaMinutes(distanceKm(from, updated)) : null });
    }
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
      if (row.provider_id) notifier.notify(row.provider_id, 'job_cancelled', { job: updated });
      return toDto(updated, user);
    }
    if (user.id === row.provider_id) {
      if (!['accepted', 'en_route'].includes(row.status)) throw conflict('This job can no longer be cancelled');
      // A pro dropping out puts the job back on the market rather than failing the customer.
      // Back to everyone, including if they were the pro the customer asked for.
      db.prepare(`UPDATE jobs SET status = 'requested', provider_id = NULL, accepted_at = NULL, preferred_released = 1 WHERE id = ?`).run(id);
      notify(row.provider_id, 'job:released', { id });
      const requeued = getJobRow(id);
      notifyParties(requeued);
      notifier.notify(row.customer_id, 'job_released', { job: requeued, proName: row.provider_name });
      dispatch(requeued);
      return { id, status: 'released' };
    }
    throw forbidden();
  }

  function rate(user, id, input) {
    reviews.submit(user, id, input);
    const updated = getJobRow(id);
    notifyParties(updated);
    return toDto(updated, user);
  }

  function messages(user, id) {
    const row = requireJob(id);
    if (user.id !== row.customer_id && user.id !== row.provider_id && user.role !== 'admin') throw forbidden();
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
    notifier.notify(user.id === row.customer_id ? row.provider_id : row.customer_id, 'new_message', {
      job: row, senderName: user.name, text,
    });
    return message;
  }

  /** Pushes a pro's position to the customer of their active job, if any. */
  function relayLocation(providerId, point) {
    const job = db.prepare(`SELECT id, customer_id FROM jobs WHERE provider_id = ? AND status IN (${ACTIVE_SQL})`).get(providerId);
    if (job) notify(job.customer_id, 'provider:location', { jobId: job.id, ...point });
  }



  return {
    estimate, create, listForUser, getForUser, openRequestsFor, accept, advance, cancel, rate,
    messages, sendMessage, relayLocation, payBooking, confirmPayment, payMaterials, payments,
    disputes, reviews, toDto, getJobRow, JOB_SELECT, releaseExpiredPreferences, preferredInfo, checkPreferred,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
