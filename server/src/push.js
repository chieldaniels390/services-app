import webpush from 'web-push';
import { badRequest } from './errors.js';

// Browsers hand out subscription endpoints on their vendor's push service. Only sending to those hosts stops
// a user from registering an internal URL and making the server POST to it.
const PUSH_SERVICE_HOSTS = ['.googleapis.com', '.mozilla.com', '.mozaws.net', '.notify.windows.com', '.push.apple.com'];
const isPushServiceHost = (host) => PUSH_SERVICE_HOSTS.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));

/**
 * Web Push (works in Chrome, Edge, Firefox, Safari 16+ and installed iOS web apps).
 * VAPID keys come from env; otherwise they're generated once and kept in the database, because every
 * existing subscription is tied to the public key.
 */
export function createPushService({
  db, publicKey, privateKey, subject, allowEndpoint = isPushServiceHost, sendNotification = webpush.sendNotification,
}) {
  let keys = publicKey && privateKey ? { publicKey, privateKey } : null;
  if (!keys) {
    const saved = db.prepare("SELECT value FROM settings WHERE key = 'vapid_keys'").get();
    keys = saved ? JSON.parse(saved.value) : webpush.generateVAPIDKeys();
    if (!saved) db.prepare("INSERT INTO settings (key, value) VALUES ('vapid_keys', ?)").run(JSON.stringify(keys));
  }
  const vapidDetails = { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };

  function subscribe(userId, subscription, userAgent = '') {
    const { endpoint, keys: subKeys } = subscription ?? {};
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw badRequest('Invalid push subscription');
    }
    if (!allowEndpoint(url.hostname, url) || !subKeys?.p256dh || !subKeys?.auth) throw badRequest('Invalid push subscription');
    // An endpoint belongs to one browser; if someone else signs in on it, it moves to them.
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent`).run(userId, endpoint, subKeys.p256dh, subKeys.auth, String(userAgent).slice(0, 200));
  }

  function unsubscribe(userId, endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint ?? ''));
  }

  const subscriptionCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;

  /** Sends to every browser the user subscribed. Dead subscriptions (404/410) are removed. */
  async function send(userId, payload, { urgency = 'normal', ttlSeconds = 3600 } = {}) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    await Promise.all(subs.map(async (s) => {
      try {
        await sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { vapidDetails, TTL: ttlSeconds, urgency, timeout: 10000 },
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        } else {
          console.warn(`Push to user ${userId} failed:`, err.statusCode ?? '', err.body ?? err.message);
        }
      }
    }));
  }

  return { publicKey: keys.publicKey, subscribe, unsubscribe, subscriptionCount, send };
}
