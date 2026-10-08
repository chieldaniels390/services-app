import { randomBytes } from 'node:crypto';
import { HttpError, badRequest, conflict } from './errors.js';

// Paystack references allow letters, digits, '-' and '_'. A fresh one per attempt keeps retries unambiguous.
const newReference = (prefix, id) => `${prefix}_${id}_${randomBytes(8).toString('hex')}`;
const BANKS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Money flow: the customer pays the upfront price at booking and it sits in the platform's Paystack
 * balance. When the pro completes the job, their share (price minus the platform fee) is sent to
 * their bank account with a Paystack transfer. Parts the pro adds at completion are approved and
 * paid by the customer separately and passed on to the pro in full.
 */
export function createPaymentService({ db, paystack, appUrl, onBookingPaid, onJobChanged, onPayoutChanged }) {
  const getJob = (id) => db.prepare('SELECT j.*, u.email AS customer_email FROM jobs j JOIN users u ON u.id = j.customer_id WHERE j.id = ?').get(id);
  const getPayment = (reference) => db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);

  async function checkout(job, kind, amountCents) {
    const reference = newReference(kind === 'booking' ? 'bk' : 'mt', job.id);
    db.prepare('INSERT INTO payments (job_id, kind, reference, amount_cents) VALUES (?, ?, ?, ?)').run(job.id, kind, reference, amountCents);
    try {
      const data = await paystack.initialize({
        email: job.customer_email,
        amountCents,
        reference,
        callbackUrl: `${appUrl}/jobs/${job.id}`,
        metadata: { jobId: job.id, kind },
      });
      db.prepare('UPDATE payments SET authorization_url = ? WHERE reference = ?').run(data.authorization_url, reference);
      return { authorizationUrl: data.authorization_url, reference };
    } catch (err) {
      db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ?").run(reference);
      throw err;
    }
  }

  const startBooking = (jobId) => {
    const job = getJob(jobId);
    return checkout(job, 'booking', job.estimated_cents);
  };

  /**
   * Checks a payment with Paystack and applies it to its job. Safe to call repeatedly and concurrently
   * (the customer returning from checkout and the webhook usually race): only the first caller to flip
   * the payment to 'paid' applies it.
   */
  async function confirm(reference) {
    const payment = getPayment(reference);
    if (!payment || payment.status !== 'pending') return payment;
    const data = await paystack.verify(reference);
    if (data.status === 'failed' || data.status === 'reversed') {
      db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ? AND status = 'pending'").run(reference);
      return getPayment(reference);
    }
    if (data.status !== 'success') return payment; // abandoned/ongoing: the customer can still finish paying
    if (data.amount !== payment.amount_cents || data.currency !== 'ZAR') {
      console.error(`Payment ${reference} amount/currency mismatch`, data.amount, data.currency);
      db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ?").run(reference);
      return getPayment(reference);
    }

    const savedCard = data.authorization?.reusable ? data.authorization.authorization_code : null;
    const { changes } = db.prepare(`
      UPDATE payments SET status = 'paid', paid_at = datetime('now'), authorization_code = ?
      WHERE reference = ? AND status = 'pending'`).run(savedCard, reference);
    if (changes) await apply(payment);
    return getPayment(reference);
  }

  async function apply(payment) {
    if (payment.kind === 'booking') {
      const { changes } = db.prepare(`
        UPDATE jobs SET payment_status = 'paid', status = 'requested'
        WHERE id = ? AND status = 'awaiting_payment' AND payment_status = 'unpaid'`).run(payment.job_id);
      // Paid twice (two checkout tabs) or cancelled while paying: give this one back.
      if (!changes) return refundStray(payment);
      return onBookingPaid(payment.job_id);
    }
    const { changes } = db.prepare("UPDATE jobs SET materials_status = 'paid' WHERE id = ? AND materials_status = 'unpaid'").run(payment.job_id);
    if (!changes) return refundStray(payment);
    const job = getJob(payment.job_id);
    await createPayout(job, 'materials', job.materials_cents);
    onJobChanged(job.id);
  }

  async function refundStray(payment) {
    try {
      await paystack.refund(payment.reference);
      db.prepare("UPDATE payments SET status = 'refund_pending' WHERE id = ?").run(payment.id);
    } catch (err) {
      console.error(`Could not refund duplicate payment ${payment.reference} - refund it from the Paystack dashboard`, err);
      db.prepare("UPDATE payments SET status = 'refund_failed' WHERE id = ?").run(payment.id);
    }
  }

  /** Full refund of the booking payment when a paid job is cancelled. Throws (and changes nothing) if Paystack refuses. */
  async function refundBooking(jobId) {
    const payment = db.prepare("SELECT * FROM payments WHERE job_id = ? AND kind = 'booking' AND status = 'paid'").get(jobId);
    const { changes } = db.prepare("UPDATE jobs SET payment_status = 'refund_pending' WHERE id = ? AND payment_status = 'paid'").run(jobId);
    if (!changes || !payment) throw conflict('This booking is already being refunded');
    try {
      await paystack.refund(payment.reference);
    } catch (err) {
      db.prepare("UPDATE jobs SET payment_status = 'paid' WHERE id = ?").run(jobId);
      throw new HttpError(502, `We couldn't start your refund (${err.message}). Please try again.`);
    }
    db.prepare("UPDATE payments SET status = 'refund_pending' WHERE id = ?").run(payment.id);
  }

  function refundProcessed(reference) {
    const payment = getPayment(reference);
    if (!payment) return;
    db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
    if (payment.kind === 'booking') {
      db.prepare("UPDATE jobs SET payment_status = 'refunded' WHERE id = ? AND payment_status = 'refund_pending'").run(payment.job_id);
    }
    onJobChanged(payment.job_id);
  }

  /** Parts the pro added at completion: charge the card saved at booking, or fall back to a checkout link. */
  async function payMaterials(jobId) {
    const job = getJob(jobId);
    if (job.materials_status !== 'unpaid') throw conflict('There is nothing left to pay on this job');
    const saved = db.prepare(`
      SELECT authorization_code FROM payments
      WHERE job_id = ? AND kind = 'booking' AND authorization_code IS NOT NULL ORDER BY id DESC`).get(jobId);
    if (saved) {
      const reference = newReference('mt', jobId);
      db.prepare("INSERT INTO payments (job_id, kind, reference, amount_cents) VALUES (?, 'materials', ?, ?)").run(jobId, reference, job.materials_cents);
      try {
        const data = await paystack.chargeAuthorization({
          email: job.customer_email, amountCents: job.materials_cents, authorizationCode: saved.authorization_code, reference,
          metadata: { jobId, kind: 'materials' },
        });
        if (data.status === 'success') {
          await confirm(reference);
          if (getJob(jobId).materials_status === 'paid') return { status: 'paid' };
        }
      } catch (err) {
        console.warn(`Saved-card charge failed for job ${jobId}, falling back to checkout:`, err.message);
      }
    }
    return checkout(job, 'materials', job.materials_cents);
  }

  // --- Payouts ---------------------------------------------------------

  async function createPayout(job, kind, amountCents) {
    if (amountCents <= 0) return;
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO payouts (job_id, provider_id, kind, amount_cents, reference) VALUES (?, ?, ?, ?, ?)`)
      .run(job.id, job.provider_id, kind, amountCents, newReference('po', job.id));
    await sendPayout(Number(lastInsertRowid));
  }

  /** Never throws: a payout that can't go out yet is recorded and retried later. */
  async function sendPayout(payoutId) {
    const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId);
    const account = db.prepare('SELECT payout_recipient_code FROM provider_profiles WHERE user_id = ?').get(payout.provider_id);
    if (!account?.payout_recipient_code) {
      db.prepare("UPDATE payouts SET status = 'awaiting_details' WHERE id = ?").run(payoutId);
      return onPayoutChanged(payout.provider_id);
    }
    // Claim it so two retries can't send the same payout twice.
    const { changes } = db.prepare(`
      UPDATE payouts SET status = 'sending', updated_at = datetime('now')
      WHERE id = ? AND status IN ('awaiting_details', 'failed')`).run(payoutId);
    if (!changes) return;

    const fail = (reason, definitive) => {
      // After a definite failure Paystack won't accept the same reference again; after a timeout we keep it,
      // so if the first request did go through, the retry is rejected as a duplicate instead of paying twice.
      const reference = definitive ? newReference('po', payout.job_id) : payout.reference;
      db.prepare("UPDATE payouts SET status = 'failed', failure_reason = ?, reference = ?, updated_at = datetime('now') WHERE id = ?")
        .run(reason, reference, payoutId);
    };
    try {
      const data = await paystack.transfer({
        amountCents: payout.amount_cents,
        recipient: account.payout_recipient_code,
        reference: payout.reference,
        reason: `Job #${payout.job_id}${payout.kind === 'materials' ? ' parts' : ''}`,
      });
      if (data.status === 'success') {
        db.prepare("UPDATE payouts SET status = 'paid', transfer_code = ?, paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(data.transfer_code, payoutId);
      } else if (data.status === 'otp') {
        fail('Transfers need OTP turned off in the Paystack dashboard (Settings > Preferences)', true);
      } else if (data.status === 'failed') {
        fail('Paystack could not send this transfer', true);
      } else {
        db.prepare("UPDATE payouts SET status = 'processing', transfer_code = ?, updated_at = datetime('now') WHERE id = ?").run(data.transfer_code, payoutId);
      }
    } catch (err) {
      console.error(`Payout ${payoutId} failed:`, err.message);
      fail(err.message, Boolean(err.definitive));
    }
    onPayoutChanged(payout.provider_id);
  }

  async function retryPayouts(providerId) {
    const due = db.prepare("SELECT id FROM payouts WHERE provider_id = ? AND status IN ('awaiting_details', 'failed') ORDER BY id").all(providerId);
    for (const { id } of due) await sendPayout(id);
  }

  function transferEvent(event, data) {
    const payout = db.prepare('SELECT * FROM payouts WHERE reference = ?').get(data?.reference);
    if (!payout) return;
    if (event === 'transfer.success') {
      db.prepare("UPDATE payouts SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(payout.id);
    } else {
      db.prepare("UPDATE payouts SET status = 'failed', failure_reason = ?, reference = ?, updated_at = datetime('now') WHERE id = ?")
        .run(event === 'transfer.reversed' ? 'The bank reversed this transfer' : data.reason || 'The transfer failed', newReference('po', payout.job_id), payout.id);
    }
    onPayoutChanged(payout.provider_id);
  }

  function payoutsFor(providerId) {
    return db.prepare(`
      SELECT p.id, p.job_id AS jobId, p.kind, p.amount_cents AS amountCents, p.status, p.failure_reason AS failureReason,
        p.created_at AS createdAt, p.paid_at AS paidAt, c.name AS categoryName, c.icon AS categoryIcon
      FROM payouts p JOIN jobs j ON j.id = p.job_id JOIN categories c ON c.id = j.category_id
      WHERE p.provider_id = ? ORDER BY p.id DESC LIMIT 200`).all(providerId);
  }

  // --- Pro bank accounts -------------------------------------------------

  let banksCache = null;
  async function banks() {
    if (!banksCache || banksCache.at < Date.now() - BANKS_TTL_MS) {
      const list = await paystack.listBanks();
      banksCache = {
        at: Date.now(),
        list: list.filter((b) => b.active !== false && !b.is_deleted).map((b) => ({ name: b.name, code: b.code })),
      };
    }
    return banksCache.list;
  }

  async function setPayoutAccount(providerId, { bankCode, accountNumber, accountName }) {
    const number = String(accountNumber ?? '').replace(/\s/g, '');
    if (!/^\d{6,16}$/.test(number)) throw badRequest('Enter a valid account number (digits only)');
    if (!String(accountName ?? '').trim()) throw badRequest('Enter the account holder name');
    const bank = (await banks()).find((b) => b.code === bankCode);
    if (!bank) throw badRequest('Choose your bank');
    const recipient = await paystack.createRecipient({ name: accountName.trim(), accountNumber: number, bankCode });
    db.prepare(`
      UPDATE provider_profiles SET payout_recipient_code = ?, payout_bank_name = ?, payout_account_last4 = ?, payout_account_name = ?
      WHERE user_id = ?`).run(recipient.recipient_code, bank.name, number.slice(-4), accountName.trim().slice(0, 100), providerId);
    await retryPayouts(providerId);
  }

  return {
    configured: paystack.configured,
    testMode: paystack.testMode,
    isValidSignature: paystack.isValidSignature,
    startBooking, checkout, confirm, refundBooking, refundProcessed, payMaterials,
    createPayout, retryPayouts, transferEvent, payoutsFor, banks, setPayoutAccount,
    getPayment,
  };
}
