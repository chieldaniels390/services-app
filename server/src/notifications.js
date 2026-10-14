import { toE164 } from './phone.js';

/** "R1 000" / "R12.50". Plain ASCII, because one emoji or curly quote halves what fits in an SMS. */
export function rand(cents) {
  const whole = Math.floor(cents / 100).toLocaleString('en-US').replace(/,/g, ' ');
  return `R${whole}${cents % 100 ? `.${String(cents % 100).padStart(2, '0')}` : ''}`;
}
const first = (name) => (name ?? '').split(' ')[0] || 'Your pro';

/**
 * Every notification the app sends. Each returns its text and which channels it uses:
 *   inApp - saved to the bell and pushed live to open tabs
 *   push  - browser/phone notification, even when the app is closed
 *   sms   - only for the moments a customer must not miss (and that cost money to send)
 */
export const TEMPLATES = {
  job_accepted: ({ job, link }) => ({
    title: `${first(job.provider_name)} accepted your job`,
    body: `${job.category_name}: they'll head over soon. You can chat with them in the app.`,
    sms: `ProNow: ${first(job.provider_name)} accepted your ${job.category_name.toLowerCase()} job. Track it: ${link}`,
    channels: { inApp: true, push: true, sms: true },
  }),
  pro_en_route: ({ job, eta, link }) => ({
    title: `${first(job.provider_name)} is on the way`,
    body: eta ? `Arriving in about ${eta} min. Track them live.` : 'Track them live in the app.',
    sms: `ProNow: ${first(job.provider_name)} is on the way${eta ? ` and should arrive in about ${eta} min` : ''}. Track: ${link}`,
    channels: { inApp: true, push: true, sms: true },
  }),
  pro_arrived: ({ job }) => ({
    title: `${first(job.provider_name)} has arrived`,
    body: `Your ${job.category_name.toLowerCase()} pro is at the door.`,
    channels: { inApp: true, push: true },
  }),
  job_completed: ({ job, link }) => ({
    title: 'Job complete',
    body: job.materials_cents > 0
      ? `Please approve ${rand(job.materials_cents)} for parts, then rate ${first(job.provider_name)}.`
      : `Total ${rand(job.final_cents)}. How did ${first(job.provider_name)} do?`,
    sms: `ProNow: your ${job.category_name.toLowerCase()} job is done. Total ${rand(job.final_cents)}.`
      + `${job.materials_cents > 0 ? ' Please approve the parts in the app' : ` Rate ${first(job.provider_name)}`}: ${link}`,
    channels: { inApp: true, push: true, sms: true },
  }),
  job_cancelled: ({ job }) => ({
    title: 'Job cancelled',
    body: `${first(job.customer_name)} cancelled the ${job.category_name.toLowerCase()} job.`,
    url: '/',
    channels: { inApp: true, push: true },
  }),
  job_released: ({ job, proName }) => ({
    title: 'Finding you another pro',
    body: `${first(proName)} couldn't make it. Your request is back out to nearby pros.`,
    channels: { inApp: true, push: true },
  }),
  new_offer: ({ job, distanceKm, payoutCents }) => ({
    title: `New ${job.category_name.toLowerCase()} request`,
    body: `${distanceKm} km away · you'd earn ${rand(payoutCents)}`,
    tag: 'offers',
    channels: { push: true }, // the request list is the in-app view
  }),
  rebook_offer: ({ job, distanceKm, payoutCents }) => ({
    title: `${first(job.customer_name)} wants to book you again`,
    body: `${job.category_name} · ${distanceKm} km away · you'd earn ${rand(payoutCents)}. It's yours first for a few minutes.`,
    tag: 'offers',
    channels: { push: true, inApp: true },
  }),
  preferred_unavailable: ({ job }) => ({
    title: 'Sent to other pros',
    body: `The pro you asked for isn't available, so your ${job.category_name.toLowerCase()} request has gone to other trusted pros nearby.`,
    channels: { inApp: true, push: true },
  }),
  recurring_booked: ({ job, when }) => ({
    title: `Your ${job.category_name.toLowerCase()} visit is booked`,
    body: `${when}. ${rand(job.estimated_cents)} was charged to your saved card.`,
    channels: { inApp: true, push: true },
  }),
  recurring_payment_needed: ({ job, when }) => ({
    title: `Payment needed for your ${job.category_name.toLowerCase()} visit`,
    body: `We couldn't charge your saved card for ${when}. Tap to pay so we can find your pro.`,
    channels: { inApp: true, push: true },
  }),
  new_message: ({ job, senderName, text }) => ({
    title: senderName,
    body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
    tag: `chat-${job.id}`,
    channels: { push: true }, // the chat itself is the in-app view
  }),
  payout_paid: ({ amountCents, jobId }) => ({
    title: `${rand(amountCents)} paid to your bank`,
    body: `Payout for job #${jobId}. It can take a business day to reflect.`,
    url: '/payouts',
    channels: { inApp: true, push: true },
  }),
  refund_issued: ({ job, amountCents }) => ({
    title: `Refund of ${rand(amountCents)} on its way`,
    body: `For your ${job.category_name.toLowerCase()} job. Card refunds usually take 5-10 business days.`,
    channels: { inApp: true, push: true },
  }),
  verification_approved: () => ({
    title: "You're verified!",
    body: 'Go online to start receiving jobs.',
    url: '/',
    channels: { inApp: true, push: true },
  }),
  verification_rejected: ({ note }) => ({
    title: 'Verification needs attention',
    body: note,
    url: '/verification',
    channels: { inApp: true, push: true },
  }),
  trades_approved: ({ names }) => ({
    title: 'New trades approved',
    body: `You'll now get ${names.join(', ').toLowerCase()} requests.`,
    url: '/work',
    channels: { inApp: true, push: true },
  }),
  trades_rejected: ({ names }) => ({
    title: "We couldn't add some trades",
    body: `${names.join(', ')} wasn't approved. Upload a certificate that covers it, or contact support.`,
    url: '/work',
    channels: { inApp: true, push: true },
  }),
  review_received: ({ job, rating }) => ({
    title: `${first(job.customer_name)} rated you ${rating} star${rating === 1 ? '' : 's'}`,
    body: `For the ${job.category_name.toLowerCase()} job on #${job.id}. See your reviews on your profile.`,
    url: `/pros/${job.provider_id}`,
    channels: { inApp: true, push: true },
  }),
  dispute_opened: ({ job }) => ({
    title: `A problem was reported on job #${job.id}`,
    body: 'Our team is looking into it and will be in touch.',
    channels: { inApp: true, push: true },
  }),
  dispute_resolved: ({ job, note }) => ({
    title: `Problem on job #${job.id} resolved`,
    body: note,
    channels: { inApp: true, push: true },
  }),
};

/**
 * Delivers notifications without ever slowing down or failing the action that caused them:
 * deliveries run in the background and errors are logged. idle() lets tests wait for them.
 */
export function createNotifier({ db, emit, push, sms, appUrl, defaultCountryCode = '27' }) {
  const inFlight = new Set();
  const track = (promise) => {
    const p = promise.catch((err) => console.error('Notification delivery failed:', err)).finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  function notify(userId, type, ctx = {}) {
    if (!userId) return;
    const jobId = ctx.job?.id ?? ctx.jobId ?? null;
    const url = jobId ? `/jobs/${jobId}` : '/';
    const n = TEMPLATES[type]({ ...ctx, link: `${appUrl}${url}` });
    const target = n.url ?? url;

    if (n.channels.inApp) {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO notifications (user_id, type, title, body, url, job_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(userId, type, n.title, n.body ?? '', target, jobId);
      emit(userId, 'notification:new', toDto(db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(lastInsertRowid))));
    }
    if (n.channels.push && push) {
      track(push.send(userId, { title: n.title, body: n.body, url: target, tag: n.tag ?? (jobId ? `job-${jobId}` : type) }, {
        urgency: n.channels.sms ? 'high' : 'normal',
      }));
    }
    if (n.channels.sms && sms) track(sendSms(userId, n.sms, jobId, type));
  }

  async function sendSms(userId, body, jobId, type) {
    const user = db.prepare('SELECT phone, sms_enabled FROM users WHERE id = ?').get(userId);
    const to = toE164(user?.phone, defaultCountryCode);
    if (!user?.sms_enabled || !to) return;
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO sms_messages (user_id, job_id, type, to_number, body, provider) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, jobId, type, to, body, sms.name);
    const id = Number(lastInsertRowid);
    try {
      const result = await sms.send({ to, body });
      db.prepare("UPDATE sms_messages SET status = 'sent', provider_message_id = ? WHERE id = ?").run(result?.id ?? null, id);
    } catch (err) {
      db.prepare("UPDATE sms_messages SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 300), id);
      console.warn(`SMS to user ${userId} failed:`, err.message);
    }
  }

  const toDto = (r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, url: r.url, jobId: r.job_id, read: !!r.read_at, createdAt: r.created_at });

  function list(userId, limit = 30) {
    const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, Math.min(100, limit)).map(toDto);
    const { unread } = db.prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId);
    return { items, unread };
  }

  function markRead(userId, ids) {
    if (ids === 'all') {
      db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(userId);
    } else {
      const stmt = db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id = ? AND read_at IS NULL");
      for (const id of ids) stmt.run(userId, Number(id));
    }
    return list(userId);
  }

  return { notify, list, markRead, idle: () => Promise.all([...inFlight]) };
}
