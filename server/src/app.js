import { createServer } from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createToken, hashPassword, readToken, verifyPassword } from './auth.js';
import { config } from './config.js';
import { transaction } from './db.js';
import { HttpError, badRequest, conflict, forbidden } from './errors.js';
import { createGeocoder } from './geocoder.js';
import { isValidPoint } from './geo.js';
import { createJobService, ratingOf } from './jobs.js';
import { createAdminService } from './admin.js';
import { DISPUTE_REASONS } from './disputes.js';
import { createNotifier } from './notifications.js';
import { createPaystack } from './paystack.js';
import { toE164 } from './phone.js';
import { createPushService } from './push.js';
import { createSmsProvider } from './sms/index.js';
import { DOCUMENT_KINDS, MAX_DOCUMENT_BYTES, createVerificationService } from './verification.js';
import { JOB_SIZES } from './pricing.js';

const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

export function createApp({
  db,
  geocoder = createGeocoder(config.geocoder),
  paystack = createPaystack(config.paystack),
  uploadDir = config.uploadDir,
  smsProvider = createSmsProvider(config.sms.provider),
  pushOptions = {},
}) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, { cors: { origin: true } });

  const notify = (userId, event, payload) => io.to(`user:${userId}`).emit(event, payload);
  notify.providers = (event, payload) => io.to('providers').emit(event, payload);
  const notifyAdmins = (event, payload) => io.to('admins').emit(event, payload);
  const push = createPushService({ db, ...config.push, ...pushOptions });
  const notifier = createNotifier({
    db, emit: notify, push, sms: smsProvider, appUrl: config.appUrl, defaultCountryCode: config.sms.defaultCountryCode,
  });
  const jobs = createJobService({ db, notify, paystack, notifyAdmins, notifier });
  const { payments, disputes } = jobs;
  const verification = createVerificationService({ db, uploadDir, notify, notifyAdmins, notifier });
  const admin = createAdminService({ db, jobs, verification });

  const findUser = (id) => db.prepare('SELECT id, role, name, email, phone, sms_enabled FROM users WHERE id = ?').get(id);

  function profileOf(fullUser) {
    const { sms_enabled: smsEnabled, ...rest } = fullUser;
    const user = { ...rest, smsEnabled: smsEnabled !== 0 };
    if (user.role !== 'provider') return user;
    const p = db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(user.id);
    const categories = db.prepare('SELECT category_id FROM provider_categories WHERE user_id = ?').all(user.id).map((r) => r.category_id);
    return {
      ...user,
      provider: {
        bio: p.bio,
        online: !!p.is_online,
        location: p.lat == null ? null : { lat: p.lat, lng: p.lng },
        rating: ratingOf(p.rating_sum, p.rating_count),
        ratingCount: p.rating_count,
        categories,
        verificationStatus: p.verification_status,
        payoutAccount: p.payout_recipient_code
          ? { bankName: p.payout_bank_name, last4: p.payout_account_last4, accountName: p.payout_account_name }
          : null,
      },
    };
  }

  const auth = (role) => (req, _res, next) => {
    const claims = readToken(req.get('authorization')?.replace(/^Bearer /, ''));
    const user = claims && findUser(claims.sub);
    if (!user) throw new HttpError(401, 'Please sign in');
    if (role && user.role !== role) throw forbidden(`Only ${role}s can do that`);
    req.user = user;
    next();
  };

  const point = (body) => {
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!isValidPoint(lat, lng)) throw badRequest('A valid location is required');
    return { lat, lng };
  };

  const jobId = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Invalid job id');
    return id;
  };

  // Paystack webhook: needs the raw body to check the signature, so it's registered before the JSON parser.
  // Point Paystack at https://<your-domain>/api/paystack/webhook (Settings > API Keys & Webhooks).
  app.post('/api/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!payments.isValidSignature(raw, req.get('x-paystack-signature'))) return res.sendStatus(401);
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    const { data } = event;
    try {
      if (event.event === 'charge.success') await payments.confirm(data.reference);
      else if (event.event?.startsWith('transfer.')) payments.transferEvent(event.event, data);
      else if (event.event === 'refund.processed') payments.refundProcessed(data);
      res.sendStatus(200);
    } catch (err) {
      // A non-200 makes Paystack retry later, which is what we want for transient failures.
      console.error('Paystack webhook failed', event.event, err);
      res.sendStatus(500);
    }
  });

  app.use(express.json({ limit: '100kb' }));
  const api = express.Router();
  app.use('/api', api);

  api.get('/health', (_req, res) => res.json({ ok: true }));

  api.get('/config', (_req, res) => res.json({
    currency: config.currency,
    locale: config.locale,
    defaultCenter: config.defaultCenter,
    platformFeeRate: config.platformFeeRate,
    payments: { enabled: payments.configured, testMode: payments.testMode },
    jobSizes: JOB_SIZES,
    documentKinds: Object.fromEntries(Object.entries(DOCUMENT_KINDS).map(([k, v]) => [k, v.label])),
    disputeReasons: DISPUTE_REASONS,
    push: { publicKey: push.publicKey },
    map: config.map,
    sms: { enabled: Boolean(smsProvider) },
  }));

  api.get('/categories', (_req, res) => {
    res.json(db.prepare(`
      SELECT id, name, icon, description, callout_cents AS calloutCents, hourly_cents AS hourlyCents
      FROM categories ORDER BY rowid`).all());
  });

  // --- Accounts ---------------------------------------------------------

  api.post('/auth/register', (req, res) => {
    const { role, name, email, password, phone, categories = [], bio = '' } = req.body ?? {};
    if (!['customer', 'provider'].includes(role)) throw badRequest('Choose whether you are booking or offering services');
    if (!name?.trim()) throw badRequest('Name is required');
    if (!/^\S+@\S+\.\S+$/.test(email ?? '')) throw badRequest('A valid email is required');
    if (typeof password !== 'string' || password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('An account with that email already exists');

    let validCategories = [];
    if (role === 'provider') {
      const known = new Set(db.prepare('SELECT id FROM categories').all().map((c) => c.id));
      validCategories = [...new Set(categories)].filter((c) => known.has(c));
      if (!validCategories.length) throw badRequest('Pick at least one service you offer');
    }

    const id = transaction(db, () => {
      const { lastInsertRowid } = db.prepare('INSERT INTO users (role, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(role, name.trim(), email.trim(), phone?.trim() || null, hashPassword(password));
      const userId = Number(lastInsertRowid);
      if (role === 'provider') {
        db.prepare('INSERT INTO provider_profiles (user_id, bio) VALUES (?, ?)').run(userId, String(bio).slice(0, 500));
        const add = db.prepare('INSERT INTO provider_categories (user_id, category_id) VALUES (?, ?)');
        for (const c of validCategories) add.run(userId, c);
      }
      return userId;
    });
    const user = findUser(id);
    res.status(201).json({ token: createToken(user), user: profileOf(user) });
  });

  // Slows down password guessing, which matters most for admin accounts.
  const failedLogins = new Map();
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const MAX_FAILED_LOGINS = 10;

  api.post('/auth/login', (req, res) => {
    const { email, password } = req.body ?? {};
    const key = `${String(email ?? '').toLowerCase()}|${req.ip}`;
    const attempts = (failedLogins.get(key) ?? []).filter((t) => t > Date.now() - LOGIN_WINDOW_MS);
    if (attempts.length >= MAX_FAILED_LOGINS) throw new HttpError(429, 'Too many attempts - try again in 15 minutes');
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email ?? '');
    if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
      failedLogins.set(key, [...attempts, Date.now()]);
      throw new HttpError(401, 'Wrong email or password');
    }
    failedLogins.delete(key);
    const user = findUser(row.id);
    res.json({ token: createToken(user), user: profileOf(user) });
  });

  api.get('/me', auth(), (req, res) => res.json(profileOf(req.user)));

  // Contact details and notification preferences.
  api.patch('/me', auth(), (req, res) => {
    const { phone, smsEnabled } = req.body ?? {};
    if (phone !== undefined) {
      const trimmed = String(phone ?? '').trim();
      if (trimmed && !toE164(trimmed, config.sms.defaultCountryCode)) throw badRequest('Enter a valid mobile number, e.g. 082 123 4567');
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(trimmed || null, req.user.id);
    }
    if (smsEnabled !== undefined) db.prepare('UPDATE users SET sms_enabled = ? WHERE id = ?').run(smsEnabled ? 1 : 0, req.user.id);
    res.json(profileOf(findUser(req.user.id)));
  });

  // --- Notifications ----------------------------------------------------

  api.get('/notifications', auth(), (req, res) => res.json(notifier.list(req.user.id, Number(req.query.limit) || 30)));
  api.post('/notifications/read', auth(), (req, res) => {
    const ids = req.body?.all ? 'all' : (Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : []);
    res.json(notifier.markRead(req.user.id, ids));
  });
  api.post('/push/subscriptions', auth(), (req, res) => {
    push.subscribe(req.user.id, req.body, req.get('user-agent'));
    res.status(201).json({ ok: true });
  });
  api.delete('/push/subscriptions', auth(), (req, res) => {
    push.unsubscribe(req.user.id, req.body?.endpoint);
    res.json({ ok: true });
  });

  // --- Address search (proxied so the geocoder's rate limit and User-Agent rules are enforced in one place) ---

  api.get('/geocode/search', auth(), async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 3) return res.json([]);
    res.json(await geocoder.search(q.slice(0, 200)));
  });

  api.get('/geocode/reverse', auth(), async (req, res) => {
    const { lat, lng } = point(req.query);
    res.json(await geocoder.reverse(lat, lng));
  });

  // --- Customers --------------------------------------------------------

  api.post('/estimate', auth(), (req, res) => {
    res.json(jobs.estimate({ ...req.body, ...point(req.body) }));
  });

  api.post('/jobs', auth('customer'), async (req, res) => {
    res.status(201).json(await jobs.create(req.user, { ...req.body, ...point(req.body) }));
  });
  api.post('/jobs/:id/payment', auth('customer'), async (req, res) => res.json(await jobs.payBooking(req.user, jobId(req))));
  api.post('/jobs/:id/payment/confirm', auth('customer'), async (req, res) => {
    res.json(await jobs.confirmPayment(req.user, jobId(req), req.body?.reference));
  });
  api.post('/jobs/:id/materials/payment', auth('customer'), async (req, res) => res.json(await jobs.payMaterials(req.user, jobId(req))));

  api.get('/jobs', auth(), (req, res) => res.json(jobs.listForUser(req.user)));
  api.get('/jobs/:id', auth(), (req, res) => res.json(jobs.getForUser(req.user, jobId(req))));
  api.post('/jobs/:id/cancel', auth(), async (req, res) => res.json(await jobs.cancel(req.user, jobId(req))));
  api.post('/jobs/:id/rate', auth('customer'), (req, res) => res.json(jobs.rate(req.user, jobId(req), req.body ?? {})));
  api.get('/jobs/:id/messages', auth(), (req, res) => res.json(jobs.messages(req.user, jobId(req))));
  api.post('/jobs/:id/messages', auth(), (req, res) => res.status(201).json(jobs.sendMessage(req.user, jobId(req), req.body?.body)));

  // --- Pros -------------------------------------------------------------

  api.patch('/provider/status', auth('provider'), (req, res) => {
    const { online } = req.body ?? {};
    if (req.body?.lat != null || req.body?.lng != null) {
      const { lat, lng } = point(req.body);
      db.prepare("UPDATE provider_profiles SET lat = ?, lng = ?, location_updated_at = datetime('now') WHERE user_id = ?").run(lat, lng, req.user.id);
      jobs.relayLocation(req.user.id, { lat, lng });
    }
    if (online !== undefined) {
      const profile = db.prepare('SELECT lat FROM provider_profiles WHERE user_id = ?').get(req.user.id);
      if (online && !verification.isApproved(req.user.id)) throw forbidden('You can go online once your documents are approved');
      if (online && profile.lat == null) throw badRequest('Share your location before going online');
      db.prepare('UPDATE provider_profiles SET is_online = ? WHERE user_id = ?').run(online ? 1 : 0, req.user.id);
    }
    res.json(profileOf(req.user));
  });

  // --- Verification ---------------------------------------------------

  api.get('/provider/verification', auth('provider'), (req, res) => res.json(verification.statusFor(req.user.id)));
  api.put(
    '/provider/documents/:kind',
    auth('provider'),
    // The file is the request body; its type is checked from its bytes, not the header.
    express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES }),
    async (req, res) => res.json(await verification.upload(req.user.id, req.params.kind, req.body)),
  );
  api.post('/provider/verification/submit', auth('provider'), (req, res) => res.json(verification.submit(req.user.id)));

  api.get('/documents/:id', auth(), (req, res) => {
    const file = verification.documentFile(req.user, Number(req.params.id));
    res.set({
      'content-type': file.mime,
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    });
    res.sendFile(file.path);
  });

  api.get('/provider/requests', auth('provider'), (req, res) => res.json(jobs.openRequestsFor(req.user)));
  api.get('/provider/earnings', auth('provider'), (req, res) => res.json(jobs.earnings(req.user)));
  api.get('/provider/banks', auth('provider'), async (_req, res) => res.json(await payments.banks()));
  api.put('/provider/payout-account', auth('provider'), async (req, res) => {
    await payments.setPayoutAccount(req.user.id, req.body ?? {});
    res.json(profileOf(req.user));
  });
  api.get('/provider/payouts', auth('provider'), (req, res) => res.json(payments.payoutsFor(req.user.id)));
  api.post('/provider/payouts/retry', auth('provider'), async (req, res) => {
    await payments.retryPayouts(req.user.id);
    res.json(payments.payoutsFor(req.user.id));
  });
  api.post('/jobs/:id/accept', auth('provider'), (req, res) => res.json(jobs.accept(req.user, jobId(req))));
  api.post('/jobs/:id/status', auth('provider'), async (req, res) => {
    res.json(await jobs.advance(req.user, jobId(req), {
      status: req.body?.status,
      materialsCents: req.body?.materialsCents ?? 0,
    }));
  });

  // --- Disputes --------------------------------------------------------

  api.post('/jobs/:id/disputes', auth(), (req, res) => {
    disputes.open(req.user, jobId(req), req.body ?? {});
    res.status(201).json(jobs.getForUser(req.user, jobId(req)));
  });

  // --- Admin -----------------------------------------------------------

  const adminApi = express.Router();
  adminApi.use(auth('admin'));
  api.use('/admin', adminApi);
  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Invalid id');
    return id;
  };

  adminApi.get('/overview', (_req, res) => res.json(admin.overview()));
  adminApi.get('/providers', (req, res) => res.json(admin.listProviders({ status: req.query.status, q: req.query.q })));
  adminApi.get('/providers/:id', (req, res) => res.json(admin.providerDetail(idParam(req))));
  adminApi.post('/providers/:id/verification', (req, res) => {
    verification.decide(req.user.id, idParam(req), req.body ?? {});
    res.json(admin.providerDetail(idParam(req)));
  });
  adminApi.get('/jobs', (req, res) => res.json(admin.listJobs(req.query)));
  adminApi.get('/jobs/:id', (req, res) => res.json(admin.jobDetail(req.user, idParam(req))));
  adminApi.post('/jobs/:id/refunds', async (req, res) => {
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw badRequest('Give a reason for the refund');
    await payments.refundJob(idParam(req), req.body?.amountCents, reason, req.user.id);
    res.json(admin.jobDetail(req.user, idParam(req)));
  });
  adminApi.post('/jobs/:id/disputes', (req, res) => {
    disputes.open(req.user, idParam(req), req.body ?? {});
    res.status(201).json(admin.jobDetail(req.user, idParam(req)));
  });
  adminApi.get('/disputes', (req, res) => res.json(admin.listDisputes({ status: req.query.status === 'resolved' ? 'resolved' : 'open' })));
  adminApi.post('/disputes/:id/resolve', async (req, res) => {
    const dispute = await disputes.resolve(req.user, idParam(req), req.body ?? {});
    res.json(admin.jobDetail(req.user, dispute.job_id));
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Serve the built client in production so the whole app runs as one process.
  if (existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  }

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  // --- Realtime ---------------------------------------------------------

  io.use((socket, next) => {
    const claims = readToken(socket.handshake.auth?.token);
    const user = claims && findUser(claims.sub);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(`user:${user.id}`);
    if (user.role === 'admin') socket.join('admins');
    if (user.role !== 'provider') return;
    socket.join('providers');
    socket.on('location', (payload) => {
      const lat = Number(payload?.lat);
      const lng = Number(payload?.lng);
      if (!isValidPoint(lat, lng)) return;
      db.prepare("UPDATE provider_profiles SET lat = ?, lng = ?, location_updated_at = datetime('now') WHERE user_id = ?").run(lat, lng, user.id);
      jobs.relayLocation(user.id, { lat, lng });
    });
  });

  return { app, server, io, notifier };
}
