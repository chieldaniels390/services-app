import { badRequest, conflict, forbidden, notFound } from './errors.js';

export const DISPUTE_REASONS = {
  quality: 'Work not done properly',
  no_show: "Pro didn't show up or left early",
  overcharged: 'Charged the wrong amount',
  damage: 'Damage to property',
  conduct: 'Unprofessional behaviour',
  customer: 'Problem with the customer',
  other: 'Something else',
};
const DISPUTE_WINDOW_DAYS = 14;

export function createDisputeService({ db, payments, onJobChanged, notifyAdmins, onOpened = () => {}, onResolved = () => {} }) {
  const getDispute = (id) => db.prepare('SELECT * FROM disputes WHERE id = ?').get(id);

  /** Customer, assigned pro or an admin can raise a dispute once the pro is on site. Unsent payouts are held. */
  function open(user, jobId, { reason, details = '' }) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw notFound('Job not found');
    const involved = user.id === job.customer_id || user.id === job.provider_id;
    if (!involved && user.role !== 'admin') throw forbidden();
    if (!DISPUTE_REASONS[reason]) throw badRequest('Choose what went wrong');
    if (!['arrived', 'in_progress', 'completed'].includes(job.status) && user.role !== 'admin') {
      throw conflict('You can report a problem once the pro has arrived');
    }
    if (job.status === 'completed' && user.role !== 'admin') {
      const recent = db.prepare(`SELECT completed_at >= datetime('now', ?) AS ok FROM jobs WHERE id = ?`).get(`-${DISPUTE_WINDOW_DAYS} days`, jobId);
      if (!recent.ok) throw conflict(`Problems must be reported within ${DISPUTE_WINDOW_DAYS} days of the job`);
    }
    if (db.prepare("SELECT 1 FROM disputes WHERE job_id = ? AND status = 'open'").get(jobId)) {
      throw conflict('There is already an open dispute on this job');
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO disputes (job_id, opened_by, reason, details) VALUES (?, ?, ?, ?)')
      .run(jobId, user.id, reason, String(details).trim().slice(0, 2000));
    payments.holdPayouts(jobId);
    onJobChanged(jobId);
    onOpened(jobId, user.id);
    notifyAdmins('admin:updated', { type: 'dispute', jobId });
    return getDispute(Number(lastInsertRowid));
  }

  /**
   * Admin resolution: optionally refund the customer, then release the pro's held payout or cancel it.
   * The dispute is claimed first so two admins can't resolve it twice; if the refund fails it reopens.
   */
  async function resolve(admin, disputeId, { refundCents = 0, payoutAction, note }) {
    const dispute = getDispute(disputeId);
    if (!dispute) throw notFound('Dispute not found');
    if (!['release', 'cancel'].includes(payoutAction)) throw badRequest("Choose whether to release or cancel the pro's payout");
    if (!Number.isInteger(refundCents) || refundCents < 0) throw badRequest('Refund must be zero or more');
    if (!note?.trim()) throw badRequest('Add a note explaining the outcome - both sides will see it');

    const { changes } = db.prepare(`
      UPDATE disputes SET status = 'resolved', resolution_note = ?, refund_cents = ?, payout_action = ?, resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ? AND status = 'open'`).run(note.trim().slice(0, 2000), refundCents, payoutAction, admin.id, disputeId);
    if (!changes) throw conflict('This dispute has already been resolved');
    try {
      if (refundCents > 0) await payments.refundJob(dispute.job_id, refundCents, `Dispute #${disputeId}: ${note.trim()}`, admin.id);
    } catch (err) {
      db.prepare(`
        UPDATE disputes SET status = 'open', resolution_note = NULL, refund_cents = 0, payout_action = NULL, resolved_by = NULL, resolved_at = NULL
        WHERE id = ?`).run(disputeId);
      throw err;
    }
    await payments.settleHeldPayouts(dispute.job_id, payoutAction);
    onJobChanged(dispute.job_id);
    onResolved(dispute.job_id, note.trim());
    notifyAdmins('admin:updated', { type: 'dispute', jobId: dispute.job_id });
    return getDispute(disputeId);
  }

  return { open, resolve, getDispute };
}
