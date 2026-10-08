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
import { isValidPoint } from './geo.js';
import { createJobService, ratingOf } from './jobs.js';
import { JOB_SIZES } from './pricing.js';

const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

export function createApp({ db }) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server, { cors: { origin: true } });

  const notify = (userId, event, payload) => io.to(`user:${userId}`).emit(event, payload);
  notify.providers = (event, payload) => io.to('providers').emit(event, payload);
  const jobs = createJobService({ db, notify });

  const findUser = (id) => db.prepare('SELECT id, role, name, email, phone FROM users WHERE id = ?').get(id);

  function profileOf(user) {
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

  app.use(express.json({ limit: '100kb' }));
  const api = express.Router();
  app.use('/api', api);

  api.get('/health', (_req, res) => res.json({ ok: true }));

  api.get('/config', (_req, res) => res.json({
    currency: config.currency,
    defaultCenter: config.defaultCenter,
    platformFeeRate: config.platformFeeRate,
    jobSizes: JOB_SIZES,
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

  api.post('/auth/login', (req, res) => {
    const { email, password } = req.body ?? {};
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email ?? '');
    if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) throw new HttpError(401, 'Wrong email or password');
    const user = findUser(row.id);
    res.json({ token: createToken(user), user: profileOf(user) });
  });

  api.get('/me', auth(), (req, res) => res.json(profileOf(req.user)));

  // --- Customers --------------------------------------------------------

  api.post('/estimate', auth(), (req, res) => {
    res.json(jobs.estimate({ ...req.body, ...point(req.body) }));
  });

  api.post('/jobs', auth('customer'), (req, res) => {
    res.status(201).json(jobs.create(req.user, { ...req.body, ...point(req.body) }));
  });

  api.get('/jobs', auth(), (req, res) => res.json(jobs.listForUser(req.user)));
  api.get('/jobs/:id', auth(), (req, res) => res.json(jobs.getForUser(req.user, jobId(req))));
  api.post('/jobs/:id/cancel', auth(), (req, res) => res.json(jobs.cancel(req.user, jobId(req))));
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
      if (online && profile.lat == null) throw badRequest('Share your location before going online');
      db.prepare('UPDATE provider_profiles SET is_online = ? WHERE user_id = ?').run(online ? 1 : 0, req.user.id);
    }
    res.json(profileOf(req.user));
  });

  api.get('/provider/requests', auth('provider'), (req, res) => res.json(jobs.openRequestsFor(req.user)));
  api.get('/provider/earnings', auth('provider'), (req, res) => res.json(jobs.earnings(req.user)));
  api.post('/jobs/:id/accept', auth('provider'), (req, res) => res.json(jobs.accept(req.user, jobId(req))));
  api.post('/jobs/:id/status', auth('provider'), (req, res) => {
    res.json(jobs.advance(req.user, jobId(req), {
      status: req.body?.status,
      materialsCents: req.body?.materialsCents ?? 0,
    }));
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

  return { app, server, io };
}
