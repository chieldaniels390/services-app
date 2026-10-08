import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

const HOME = { lat: 51.5074, lng: -0.1278 };
let server;
let base;

before(async () => {
  ({ server } = createApp({ db: openDb(':memory:') }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let counter = 0;
async function register(role, extra = {}) {
  const { status, body } = await call('POST', '/auth/register', {
    body: { role, name: `${role} ${++counter}`, email: `${role}${counter}@test.com`, password: 'password123', phone: '555', ...extra },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body;
}

async function onlinePro(categories = ['plumbing'], at = { lat: HOME.lat + 0.01, lng: HOME.lng }) {
  const pro = await register('provider', { categories });
  const { status } = await call('PATCH', '/provider/status', { token: pro.token, body: { online: true, ...at } });
  assert.equal(status, 200);
  return pro;
}

const jobBody = (extra = {}) => ({ categoryId: 'plumbing', size: 'small', description: 'Leaking tap', address: '1 High St', ...HOME, ...extra });

describe('accounts', () => {
  test('registers, logs in and reads profile', async () => {
    const { user } = await register('customer');
    const login = await call('POST', '/auth/login', { body: { email: user.email, password: 'password123' } });
    assert.equal(login.status, 200);
    const me = await call('GET', '/me', { token: login.body.token });
    assert.equal(me.body.email, user.email);
  });

  test('rejects bad credentials and duplicate emails', async () => {
    const { user } = await register('customer');
    assert.equal((await call('POST', '/auth/login', { body: { email: user.email, password: 'nope' } })).status, 401);
    const dup = await call('POST', '/auth/register', { body: { role: 'customer', name: 'x', email: user.email, password: 'password123' } });
    assert.equal(dup.status, 409);
  });

  test('pros must offer at least one service', async () => {
    const res = await call('POST', '/auth/register', { body: { role: 'provider', name: 'x', email: 'p@x.com', password: 'password123', categories: [] } });
    assert.equal(res.status, 400);
  });

  test('protected routes require a token', async () => {
    assert.equal((await call('GET', '/jobs')).status, 401);
  });
});

describe('job lifecycle', () => {
  test('quote -> request -> accept -> complete -> rate', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();

    const est = await call('POST', '/estimate', { token: customer.token, body: jobBody() });
    assert.equal(est.status, 200);
    assert.equal(est.body.totalCents, 4900 + 8500);
    assert.ok(est.body.availableProviders >= 1);

    const created = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    assert.equal(created.status, 201);
    const { id } = created.body.job;
    assert.equal(created.body.job.status, 'requested');

    const feed = await call('GET', '/provider/requests', { token: pro.token });
    const offer = feed.body.find((j) => j.id === id);
    assert.ok(offer, 'pro should see the request');
    assert.equal(offer.address, null, 'address is hidden until accepted');

    const accepted = await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.address, '1 High St');

    for (const status of ['en_route', 'arrived', 'in_progress']) {
      const res = await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
      assert.equal(res.body.status, status);
    }
    const done = await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed', materialsCents: 1000 } });
    assert.equal(done.body.finalCents, 13400 + 1000);
    assert.equal(done.body.payoutCents, 14400 - Math.round(13400 * 0.15));

    const rated = await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: 5, comment: 'Great' } });
    assert.equal(rated.body.review.rating, 5);
    assert.equal((await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: 4 } })).status, 409);

    const me = await call('GET', '/me', { token: pro.token });
    assert.equal(me.body.provider.rating, 5);
    const earnings = await call('GET', '/provider/earnings', { token: pro.token });
    assert.equal(earnings.body.allTime.cents, done.body.payoutCents);
  });

  test('only one pro can win a job', async () => {
    const customer = await register('customer');
    const [a, b] = [await onlinePro(), await onlinePro()];
    const { body } = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    const results = await Promise.all([a, b].map((p) => call('POST', `/jobs/${body.job.id}/accept`, { token: p.token })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  });

  test('status can only move forward one step', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const { body } = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
    const skip = await call('POST', `/jobs/${body.job.id}/status`, { token: pro.token, body: { status: 'completed' } });
    assert.equal(skip.status, 409);
  });

  test('pros cannot take jobs outside their services or while busy', async () => {
    const customer = await register('customer');
    const cleaner = await onlinePro(['cleaning']);
    const { body } = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    assert.equal((await call('POST', `/jobs/${body.job.id}/accept`, { token: cleaner.token })).status, 403);

    const pro = await onlinePro();
    const second = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    assert.equal((await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token })).status, 200);
    assert.equal((await call('POST', `/jobs/${second.body.job.id}/accept`, { token: pro.token })).status, 409);
  });

  test('a pro backing out puts the job back on the market', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const { body } = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
    await call('POST', `/jobs/${body.job.id}/cancel`, { token: pro.token });
    const job = await call('GET', `/jobs/${body.job.id}`, { token: customer.token });
    assert.equal(job.body.status, 'requested');
    assert.equal(job.body.provider, null);
  });

  test('customers cannot cancel once work has started', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const { body } = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
    for (const status of ['en_route', 'arrived']) await call('POST', `/jobs/${body.job.id}/status`, { token: pro.token, body: { status } });
    assert.equal((await call('POST', `/jobs/${body.job.id}/cancel`, { token: customer.token })).status, 409);
  });

  test('outsiders cannot read a job', async () => {
    const customer = await register('customer');
    const other = await register('customer');
    const { body } = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    assert.equal((await call('GET', `/jobs/${body.job.id}`, { token: other.token })).status, 403);
  });
});

describe('realtime', () => {
  const socketFor = (token) => new Promise((resolve, reject) => {
    const s = connect(base, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

  test('offers, acceptance, chat and live location are pushed', async () => {
    const customer = await register('customer');
    const pro = await onlinePro(['electrical']);
    const [cs, ps] = await Promise.all([socketFor(customer.token), socketFor(pro.token)]);
    try {
      const offer = next(ps, 'job:offer');
      const { body } = await call('POST', '/jobs', { token: customer.token, body: jobBody({ categoryId: 'electrical' }) });
      assert.equal((await offer).id, body.job.id);

      const update = next(cs, 'job:updated');
      await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
      assert.equal((await update).status, 'accepted');

      const msg = next(ps, 'message:new');
      await call('POST', `/jobs/${body.job.id}/messages`, { token: customer.token, body: { body: 'Gate code 1234' } });
      assert.equal((await msg).body, 'Gate code 1234');

      const loc = next(cs, 'provider:location');
      ps.emit('location', { lat: 51.51, lng: -0.12 });
      assert.deepEqual(await loc, { jobId: body.job.id, lat: 51.51, lng: -0.12 });
    } finally {
      cs.close();
      ps.close();
    }
  });

  test('rejects sockets without a valid token', async () => {
    await assert.rejects(socketFor('bogus'));
  });
});
