import { DISPUTE_REASONS } from './disputes.js';
import { notFound } from './errors.js';
import { ratingOf } from './jobs.js';

const PAGE_SIZE = 50;

/** Read models for the admin panel. Actions (approve, refund, resolve) live in their own services. */
export function createAdminService({ db, jobs, verification }) {
  function overview() {
    const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args))[0];
    return {
      pendingVerifications: one("SELECT COUNT(*) FROM provider_profiles WHERE verification_status = 'pending'"),
      openDisputes: one("SELECT COUNT(*) FROM disputes WHERE status = 'open'"),
      activeJobs: one("SELECT COUNT(*) FROM jobs WHERE status IN ('requested', 'accepted', 'en_route', 'arrived', 'in_progress')"),
      jobsToday: one("SELECT COUNT(*) FROM jobs WHERE created_at >= datetime('now', 'start of day') AND status != 'awaiting_payment'"),
      onlinePros: one("SELECT COUNT(*) FROM provider_profiles WHERE is_online = 1 AND verification_status = 'approved'"),
      collected7dCents: one("SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) FROM payments WHERE status IN ('paid', 'refund_pending') AND paid_at >= datetime('now', '-7 days')"),
      fees7dCents: one("SELECT COALESCE(SUM(platform_fee_cents), 0) FROM jobs WHERE status = 'completed' AND completed_at >= datetime('now', '-7 days')"),
      payoutsNeedingAttention: one("SELECT COUNT(*) FROM payouts WHERE status IN ('failed', 'on_hold')"),
    };
  }

  function listProviders({ status, q, id }) {
    const where = ['u.role = ?'];
    const args = ['provider'];
    if (id) { where.push('u.id = ?'); args.push(id); }
    if (status) { where.push('p.verification_status = ?'); args.push(status); }
    if (q) { where.push('(u.name LIKE ? OR u.email LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    return db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.created_at AS createdAt, p.verification_status AS status,
        p.verification_submitted_at AS submittedAt, p.is_online AS online, p.rating_sum, p.rating_count,
        (SELECT GROUP_CONCAT(category_id) FROM provider_categories WHERE user_id = u.id) AS categories,
        (SELECT COUNT(*) FROM jobs WHERE provider_id = u.id AND status = 'completed') AS completedJobs
      FROM users u JOIN provider_profiles p ON p.user_id = u.id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE p.verification_status WHEN 'pending' THEN 0 ELSE 1 END, p.verification_submitted_at, u.id DESC
      LIMIT 200`).all(...args)
      .map(({ rating_sum: sum, rating_count: count, categories, online, ...p }) => ({
        ...p, online: !!online, rating: ratingOf(sum, count), ratingCount: count, categories: categories?.split(',') ?? [],
      }));
  }

  function providerDetail(id) {
    const [pro] = listProviders({ id });
    if (!pro) throw notFound('Pro not found');
    const p = db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(id);
    return {
      ...pro,
      bio: p.bio,
      verification: verification.statusFor(id),
      payoutAccount: p.payout_recipient_code ? { bankName: p.payout_bank_name, last4: p.payout_account_last4, accountName: p.payout_account_name } : null,
      recentJobs: db.prepare(`${jobs.JOB_SELECT} WHERE j.provider_id = ? ORDER BY j.id DESC LIMIT 20`).all(id).map(jobSummary),
    };
  }

  function jobSummary(row) {
    return {
      id: row.id, status: row.status, category: { name: row.category_name, icon: row.category_icon },
      customerName: row.customer_name, providerName: row.provider_name, estimatedCents: row.estimated_cents,
      finalCents: row.final_cents, paymentStatus: row.payment_status, createdAt: row.created_at,
      hasOpenDispute: !!db.prepare("SELECT 1 FROM disputes WHERE job_id = ? AND status = 'open'").get(row.id),
    };
  }

  function listJobs({ status, q, page = 1 }) {
    const where = [];
    const args = [];
    if (status === 'active') where.push("j.status IN ('requested', 'accepted', 'en_route', 'arrived', 'in_progress')");
    else if (status === 'disputed') where.push("EXISTS (SELECT 1 FROM disputes d WHERE d.job_id = j.id AND d.status = 'open')");
    else if (status) { where.push('j.status = ?'); args.push(status); }
    if (q) {
      const id = Number(String(q).replace(/^#/, ''));
      where.push('(j.id = ? OR cu.name LIKE ? OR cu.email LIKE ? OR pu.name LIKE ? OR pu.email LIKE ? OR j.address LIKE ?)');
      args.push(Number.isInteger(id) ? id : -1, ...Array(5).fill(`%${q}%`));
    }
    const offset = (Math.max(1, Number(page) || 1) - 1) * PAGE_SIZE;
    const rows = db.prepare(`${jobs.JOB_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY j.id DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`).all(...args);
    return { jobs: rows.slice(0, PAGE_SIZE).map(jobSummary), hasMore: rows.length > PAGE_SIZE };
  }

  function jobDetail(admin, id) {
    const row = jobs.getJobRow(id);
    if (!row) throw notFound('Job not found');
    const customer = db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(row.customer_id);
    const provider = row.provider_id && db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(row.provider_id);
    return {
      job: { ...jobs.toDto(row, admin), payoutCents: row.payout_cents, platformFeeCents: row.platform_fee_cents, feeRate: row.fee_rate },
      customer,
      provider: provider || null,
      payments: db.prepare(`
        SELECT id, kind, reference, amount_cents AS amountCents, refunded_cents AS refundedCents, status, paid_at AS paidAt, created_at AS createdAt
        FROM payments WHERE job_id = ? ORDER BY id`).all(id),
      payouts: db.prepare(`
        SELECT id, kind, amount_cents AS amountCents, status, failure_reason AS failureReason, reference, paid_at AS paidAt, created_at AS createdAt
        FROM payouts WHERE job_id = ? ORDER BY id`).all(id),
      refunds: db.prepare(`
        SELECT r.id, r.amount_cents AS amountCents, r.reason, r.status, r.created_at AS createdAt, u.name AS createdBy
        FROM refunds r LEFT JOIN users u ON u.id = r.created_by WHERE r.job_id = ? ORDER BY r.id`).all(id),
      disputes: db.prepare(`
        SELECT d.id, d.reason, d.details, d.status, d.resolution_note AS resolutionNote, d.refund_cents AS refundCents,
          d.payout_action AS payoutAction, d.created_at AS createdAt, d.resolved_at AS resolvedAt,
          u.name AS openedByName, u.role AS openedByRole, a.name AS resolvedByName
        FROM disputes d JOIN users u ON u.id = d.opened_by LEFT JOIN users a ON a.id = d.resolved_by
        WHERE d.job_id = ? ORDER BY d.id DESC`).all(id).map((d) => ({ ...d, reasonLabel: DISPUTE_REASONS[d.reason] })),
      messages: jobs.messages(admin, id),
      sms: db.prepare(`
        SELECT s.id, s.type, s.to_number AS toNumber, s.body, s.provider, s.status, s.error, s.created_at AS createdAt, u.name AS userName
        FROM sms_messages s JOIN users u ON u.id = s.user_id WHERE s.job_id = ? ORDER BY s.id`).all(id),
      refundableCents: db.prepare(`
        SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) AS c FROM payments
        WHERE job_id = ? AND status IN ('paid', 'refund_pending')`).get(id).c,
    };
  }

  function listDisputes({ status = 'open' }) {
    return db.prepare(`
      SELECT d.id, d.job_id AS jobId, d.reason, d.details, d.status, d.created_at AS createdAt, d.resolved_at AS resolvedAt,
        u.name AS openedByName, u.role AS openedByRole, c.name AS categoryName, c.icon AS categoryIcon,
        j.estimated_cents AS estimatedCents, cu.name AS customerName, pu.name AS providerName
      FROM disputes d
      JOIN users u ON u.id = d.opened_by
      JOIN jobs j ON j.id = d.job_id
      JOIN categories c ON c.id = j.category_id
      JOIN users cu ON cu.id = j.customer_id
      LEFT JOIN users pu ON pu.id = j.provider_id
      WHERE d.status = ? ORDER BY d.id ${status === 'open' ? 'ASC' : 'DESC'} LIMIT 200`).all(status)
      .map((d) => ({ ...d, reasonLabel: DISPUTE_REASONS[d.reason] }));
  }

  return { overview, listProviders, providerDetail, listJobs, jobDetail, listDisputes };
}
