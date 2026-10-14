import { config } from './config.js';
import { transaction } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

const avg = (sum, count) => (count ? Math.round((sum / count) * 10) / 10 : null);
const firstNameAndInitial = (name) => {
  const [first, ...rest] = String(name).split(' ');
  return rest.length ? `${first} ${rest.at(-1)[0]}.` : first;
};

/**
 * Two-way reviews. Reviews of pros are public on their profile (reviewer shown as "Naledi C.");
 * reviews of customers are only visible to admins, and pros see the customer's average.
 */
export function createReviewService({ db, notifier, notifyAdmins, now = () => new Date() }) {
  const summary = (userId) => {
    const r = db.prepare('SELECT COALESCE(SUM(rating), 0) AS sum, COUNT(*) AS count FROM reviews WHERE reviewee_id = ?').get(userId);
    return { rating: avg(r.sum, r.count), ratingCount: r.count };
  };

  const isFlagged = ({ rating, ratingCount }) =>
    rating !== null && ratingCount >= config.reviews.minReviews && rating < config.reviews.flagBelow;

  /** Who reviews whom on a job, from this user's side. */
  function sides(user, job) {
    if (user.id === job.customer_id) return { role: 'customer', revieweeId: job.provider_id };
    if (user.id === job.provider_id) return { role: 'provider', revieweeId: job.customer_id };
    return null;
  }

  const windowOpen = (job) => job.completed_at
    && new Date(`${job.completed_at.replace(' ', 'T')}Z`).getTime() + config.reviews.windowDays * 86400000 > now().getTime();

  /** The review state of a job for one viewer: their own review, the other side's (if they may see it), and whether they can still rate. */
  function forJob(user, job) {
    const side = sides(user, job);
    const rows = db.prepare('SELECT reviewer_role AS role, rating, comment, created_at AS createdAt FROM reviews WHERE job_id = ?').all(job.id);
    const mine = side && rows.find((r) => r.role === side.role);
    // Reviews of pros are public; a customer doesn't see what the pro said about them.
    const theirs = side?.role === 'provider' ? rows.find((r) => r.role === 'customer') : null;
    return {
      mine: mine ? { rating: mine.rating, comment: mine.comment, createdAt: mine.createdAt } : null,
      theirs: theirs ? { rating: theirs.rating, comment: theirs.comment, createdAt: theirs.createdAt } : null,
      canReview: Boolean(side && !mine && job.status === 'completed' && side.revieweeId && windowOpen(job)),
    };
  }

  function submit(user, jobId, { rating, comment = '' }) {
    const job = db.prepare(`
      SELECT j.*, c.name AS category_name, cu.name AS customer_name, pu.name AS provider_name
      FROM jobs j JOIN categories c ON c.id = j.category_id JOIN users cu ON cu.id = j.customer_id
      LEFT JOIN users pu ON pu.id = j.provider_id WHERE j.id = ?`).get(jobId);
    if (!job) throw notFound('Job not found');
    const side = sides(user, job);
    if (!side) throw forbidden();
    if (job.status !== 'completed') throw conflict('You can leave a rating once the job is complete');
    if (!windowOpen(job)) throw conflict(`Ratings can be left up to ${config.reviews.windowDays} days after the job`);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('Rating must be 1-5 stars');

    const before = summary(side.revieweeId);
    try {
      transaction(db, () => {
        db.prepare(`
          INSERT INTO reviews (job_id, reviewer_id, reviewee_id, reviewer_role, rating, comment) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(jobId, user.id, side.revieweeId, side.role, rating, String(comment).trim().slice(0, 500));
        // Pros' averages are cached on their profile because matching and listings read them constantly.
        if (side.role === 'customer') {
          db.prepare('UPDATE provider_profiles SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?')
            .run(rating, side.revieweeId);
        }
      });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw conflict('You have already rated this job');
      throw err;
    }

    if (side.role === 'customer') notifier.notify(side.revieweeId, 'review_received', { job, rating });
    const after = summary(side.revieweeId);
    if (isFlagged(after) && !isFlagged(before)) notifyAdmins('admin:updated', { type: 'rating', userId: side.revieweeId });
    return forJob(user, job);
  }

  /** A pro's public profile: rating, completed jobs and recent reviews. */
  function providerProfile(proId, viewerId = null) {
    const pro = db.prepare(`
      SELECT u.id, u.name, u.created_at AS memberSince, p.bio, p.verification_status AS status
      FROM users u JOIN provider_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'provider'`).get(proId);
    if (!pro) throw notFound('Pro not found');
    const breakdown = Object.fromEntries([5, 4, 3, 2, 1].map((n) => [n, 0]));
    for (const r of db.prepare('SELECT rating, COUNT(*) AS n FROM reviews WHERE reviewee_id = ? GROUP BY rating').all(proId)) breakdown[r.rating] = r.n;
    return {
      id: pro.id,
      name: pro.name,
      bio: pro.bio,
      verified: pro.status === 'approved',
      memberSince: pro.memberSince,
      trades: db.prepare("SELECT category_id FROM provider_categories WHERE user_id = ? AND status = 'approved'").all(proId).map((r) => r.category_id),
      completedJobs: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE provider_id = ? AND status = 'completed'").get(proId).n,
      // Customers can rebook pros who have done a job for them.
      workedWithYou: Boolean(viewerId && db.prepare("SELECT 1 FROM jobs WHERE provider_id = ? AND customer_id = ? AND status = 'completed'").get(proId, viewerId)),
      ...summary(proId),
      breakdown,
      recentReviews: db.prepare(`
        SELECT r.rating, r.comment, r.created_at AS createdAt, u.name AS reviewer, c.name AS categoryName, c.icon AS categoryIcon
        FROM reviews r JOIN users u ON u.id = r.reviewer_id JOIN jobs j ON j.id = r.job_id JOIN categories c ON c.id = j.category_id
        WHERE r.reviewee_id = ? ORDER BY r.id DESC LIMIT 20`).all(proId)
        .map(({ reviewer, ...r }) => ({ ...r, reviewer: firstNameAndInitial(reviewer) })),
    };
  }

  /** Recent reviews someone received, with full reviewer names, for admins. */
  function receivedForAdmin(userId, limit = 10) {
    return db.prepare(`
      SELECT r.job_id AS jobId, r.rating, r.comment, r.created_at AS createdAt, u.name AS reviewer, u.id AS reviewerId
      FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.reviewee_id = ? ORDER BY r.id DESC LIMIT ?`).all(userId, limit);
  }

  /** Everyone whose average has dropped below the threshold, worst first. */
  function flagged() {
    return db.prepare(`
      SELECT u.id, u.name, u.email, u.role, AVG(r.rating) AS average, COUNT(*) AS count,
        SUM(CASE WHEN r.rating <= 2 THEN 1 ELSE 0 END) AS lowCount, MAX(r.created_at) AS lastReviewAt,
        p.verification_status AS verificationStatus
      FROM reviews r JOIN users u ON u.id = r.reviewee_id LEFT JOIN provider_profiles p ON p.user_id = u.id
      GROUP BY u.id HAVING COUNT(*) >= ? AND AVG(r.rating) < ?
      ORDER BY AVG(r.rating), COUNT(*) DESC`).all(config.reviews.minReviews, config.reviews.flagBelow)
      .map((u) => ({ ...u, average: Math.round(u.average * 10) / 10, recent: receivedForAdmin(u.id, 3) }));
  }

  return { summary, isFlagged, forJob, submit, providerProfile, receivedForAdmin, flagged };
}
