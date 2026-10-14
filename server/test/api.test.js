import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/auth.js';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createPaystack } from '../src/paystack.js';
import { startFakePaystack } from './fakePaystack.js';
import { solidPng } from '../src/png.js';

const HOME = { lat: -26.2041, lng: 28.0473 }; // Johannesburg
const SECRET = 'sk_test_fake';
let server;
let base;
let fake;
let db;
let uploadDir;
let adminToken;
let notifier;
let runScheduler;
let clockTime = null; // null = real time; tests set it to check working hours
const sentSms = [];
const pushed = []; // { endpoint, headers, payload }
const goneEndpoints = new Set();

before(async () => {
  const geocoder = {
    search: async (q) => [{ label: `Result for ${q}`, lat: -33.9249, lng: 18.4241 }],
    reverse: async (lat, lng) => ({ label: 'Somewhere', lat, lng }),
  };
  fake = await startFakePaystack({ secretKey: SECRET });
  const paystack = createPaystack({ secretKey: SECRET, baseUrl: fake.url });
  db = openDb(':memory:');
  uploadDir = mkdtempSync(path.join(tmpdir(), 'pronow-uploads-'));
  const smsProvider = { name: 'test', send: async (msg) => { sentSms.push(msg); return { id: `sms-${sentSms.length}` }; } };
  // Runs web-push's real encryption and VAPID signing, then records the request instead of sending it.
  const sendNotification = async (subscription, payload, options) => {
    const request = webpush.generateRequestDetails(subscription, payload, options);
    if (goneEndpoints.has(subscription.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    pushed.push({ endpoint: subscription.endpoint, headers: request.headers, payload: JSON.parse(payload) });
  };
  ({ server, notifier, runScheduler } = createApp({
    db, geocoder, paystack, uploadDir, smsProvider,
    pushOptions: { allowEndpoint: (host) => host === 'push.test', sendNotification },
    now: () => (clockTime ? new Date(clockTime) : new Date()),
    schedulerIntervalMs: 0,
  }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Ops', 'ops@test.com', ?)").run(hashPassword('admin-password-1'));
  adminToken = (await call('POST', '/auth/login', { body: { email: 'ops@test.com', password: 'admin-password-1' } })).body.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fake.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

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

// Most tests aren't about verification, so approve pros directly. The verification tests use the real flow.
const approveDirectly = (pro) => {
  db.prepare("UPDATE provider_profiles SET verification_status = 'approved' WHERE user_id = ?").run(pro.user.id);
  db.prepare("UPDATE provider_categories SET status = 'approved' WHERE user_id = ?").run(pro.user.id);
};

async function onlinePro(categories = ['plumbing'], at = { lat: HOME.lat + 0.01, lng: HOME.lng }) {
  const pro = await register('provider', { categories });
  approveDirectly(pro);
  const { status } = await call('PATCH', '/provider/status', { token: pro.token, body: { online: true, ...at } });
  assert.equal(status, 200);
  return pro;
}

/** Books a job and pays for it, returning the job id once it's out to pros. */
async function book(customer, extra = {}) {
  const created = await call('POST', '/jobs', { token: customer.token, body: jobBody(extra) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  fake.pay(created.body.payment.reference);
  const confirmed = await call('POST', `/jobs/${created.body.job.id}/payment/confirm`, {
    token: customer.token, body: { reference: created.body.payment.reference },
  });
  assert.equal(confirmed.body.status, 'requested');
  return { id: created.body.job.id, reference: created.body.payment.reference };
}

const signed = (payload) => {
  const raw = JSON.stringify(payload);
  return { raw, signature: createHmac('sha512', SECRET).update(raw).digest('hex') };
};
async function webhook(payload, signature) {
  const s = signed(payload);
  const res = await fetch(`${base}/api/paystack/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature ?? s.signature },
    body: s.raw,
  });
  return res.status;
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
    assert.equal(est.body.totalCents, 45000 + 55000, 'plumbing quick fix: R450 call-out + 1h at R550');
    assert.ok(est.body.availableProviders >= 1);

    const { id } = await book(customer);

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
    assert.equal(done.body.finalCents, 100000 + 1000);
    assert.equal(done.body.payoutCents, 101000 - Math.round(100000 * 0.15));
    assert.equal(done.body.materialsStatus, 'unpaid');

    const rated = await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: 5, comment: 'Great' } });
    assert.deepEqual([rated.body.reviews.mine.rating, rated.body.reviews.mine.comment, rated.body.reviews.canReview], [5, 'Great', false]);
    assert.equal((await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: 4 } })).status, 409);

    const me = await call('GET', '/me', { token: pro.token });
    assert.equal(me.body.provider.rating, 5);
    const earnings = await call('GET', '/provider/earnings', { token: pro.token });
    // Parts aren't paid yet, so only the job payout counts so far; it waits for bank details.
    assert.equal(earnings.body.allTime.earningsCents, done.body.payoutCents - 1000);
    assert.equal(earnings.body.allTime.jobs, 1);
    assert.equal(earnings.body.allTime.feesCents, Math.round(100000 * 0.15));
    assert.equal(earnings.body.payouts.pendingCents, done.body.payoutCents - 1000);
  });

  test('only one pro can win a job', async () => {
    const customer = await register('customer');
    const [a, b] = [await onlinePro(), await onlinePro()];
    const { id } = await book(customer);
    const body = { job: { id } };
    const results = await Promise.all([a, b].map((p) => call('POST', `/jobs/${body.job.id}/accept`, { token: p.token })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  });

  test('status can only move forward one step', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const body = { job: await book(customer) };
    await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
    const skip = await call('POST', `/jobs/${body.job.id}/status`, { token: pro.token, body: { status: 'completed' } });
    assert.equal(skip.status, 409);
  });

  test('pros cannot take jobs outside their services or while busy', async () => {
    const customer = await register('customer');
    const cleaner = await onlinePro(['cleaning']);
    const body = { job: await book(customer) };
    assert.equal((await call('POST', `/jobs/${body.job.id}/accept`, { token: cleaner.token })).status, 403);

    const pro = await onlinePro();
    const second = { body: { job: await book(customer) } };
    assert.equal((await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token })).status, 200);
    assert.equal((await call('POST', `/jobs/${second.body.job.id}/accept`, { token: pro.token })).status, 409);
  });

  test('a pro backing out puts the job back on the market', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const body = { job: await book(customer) };
    await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
    await call('POST', `/jobs/${body.job.id}/cancel`, { token: pro.token });
    const job = await call('GET', `/jobs/${body.job.id}`, { token: customer.token });
    assert.equal(job.body.status, 'requested');
    assert.equal(job.body.provider, null);
  });

  test('customers cannot cancel once work has started', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const body = { job: await book(customer) };
    await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
    for (const status of ['en_route', 'arrived']) await call('POST', `/jobs/${body.job.id}/status`, { token: pro.token, body: { status } });
    assert.equal((await call('POST', `/jobs/${body.job.id}/cancel`, { token: customer.token })).status, 409);
  });

  test('outsiders cannot read a job', async () => {
    const customer = await register('customer');
    const other = await register('customer');
    const body = { job: await book(customer) };
    assert.equal((await call('GET', `/jobs/${body.job.id}`, { token: other.token })).status, 403);
  });
});

describe('payments', () => {
  test('a booking only reaches pros once it is paid', async () => {
    const customer = await register('customer');
    const pro = await onlinePro(['locksmith']);
    const created = await call('POST', '/jobs', { token: customer.token, body: jobBody({ categoryId: 'locksmith' }) });
    assert.equal(created.body.job.status, 'awaiting_payment');
    assert.match(created.body.payment.authorizationUrl, /\/checkout\//);
    const tx = fake.state.transactions.get(created.body.payment.reference);
    assert.equal(tx.amount, 55000 + 50000);
    assert.equal(tx.currency, 'ZAR');
    assert.equal(tx.email, customer.user.email);

    const feed = async () => (await call('GET', '/provider/requests', { token: pro.token })).body.map((j) => j.id);
    assert.ok(!(await feed()).includes(created.body.job.id), 'unpaid jobs are hidden from pros');
    assert.equal((await call('POST', `/jobs/${created.body.job.id}/accept`, { token: pro.token })).status, 409);

    // Returning from checkout without paying changes nothing.
    const unpaid = await call('POST', `/jobs/${created.body.job.id}/payment/confirm`, { token: customer.token, body: { reference: created.body.payment.reference } });
    assert.equal(unpaid.body.status, 'awaiting_payment');

    fake.pay(created.body.payment.reference);
    const paid = await call('POST', `/jobs/${created.body.job.id}/payment/confirm`, { token: customer.token, body: { reference: created.body.payment.reference } });
    assert.equal(paid.body.status, 'requested');
    assert.equal(paid.body.paymentStatus, 'paid');
    assert.ok((await feed()).includes(created.body.job.id));
  });

  test('webhooks must be signed, and charge.success confirms the booking', async () => {
    const customer = await register('customer');
    const created = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    const event = { event: 'charge.success', data: { reference: created.body.payment.reference } };
    fake.pay(created.body.payment.reference);
    assert.equal(await webhook(event, 'forged'), 401);
    assert.equal((await call('GET', `/jobs/${created.body.job.id}`, { token: customer.token })).body.status, 'awaiting_payment');
    assert.equal(await webhook(event), 200);
    assert.equal(await webhook(event), 200, 'duplicate deliveries are harmless');
    assert.equal((await call('GET', `/jobs/${created.body.job.id}`, { token: customer.token })).body.status, 'requested');
  });

  test('paying twice refunds the second payment', async () => {
    const customer = await register('customer');
    const created = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    const id = created.body.job.id;
    const again = await call('POST', `/jobs/${id}/payment`, { token: customer.token });
    for (const reference of [created.body.payment.reference, again.body.reference]) {
      fake.pay(reference);
      await call('POST', `/jobs/${id}/payment/confirm`, { token: customer.token, body: { reference } });
    }
    assert.deepEqual(fake.state.refunds, [...fake.state.refunds.filter((r) => r !== again.body.reference), again.body.reference]);
    assert.ok(fake.state.refunds.includes(again.body.reference));
    assert.ok(!fake.state.refunds.includes(created.body.payment.reference));
  });

  test('cancelling a paid booking refunds it in full', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const { id, reference } = await book(customer);
    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    const cancelled = await call('POST', `/jobs/${id}/cancel`, { token: customer.token });
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.paymentStatus, 'refund_pending');
    assert.ok(fake.state.refunds.includes(reference));
    assert.equal(await webhook({ event: 'refund.processed', data: { transaction_reference: reference } }), 200);
    assert.equal((await call('GET', `/jobs/${id}`, { token: customer.token })).body.paymentStatus, 'refunded');
  });

  test('cancelling an unpaid booking needs no refund', async () => {
    const customer = await register('customer');
    const created = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    const refunds = fake.state.refunds.length;
    const res = await call('POST', `/jobs/${created.body.job.id}/cancel`, { token: customer.token });
    assert.equal(res.body.status, 'cancelled');
    assert.equal(fake.state.refunds.length, refunds);
  });

  test('completing a job pays the pro minus the fee; parts follow once the customer pays', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const banks = await call('GET', '/provider/banks', { token: pro.token });
    const account = await call('PUT', '/provider/payout-account', {
      token: pro.token, body: { bankCode: banks.body[0].code, accountNumber: '1234 567 890', accountName: 'Test Pro' },
    });
    assert.deepEqual(account.body.provider.payoutAccount, { bankName: 'Capitec Bank', last4: '7890', accountName: 'Test Pro' });
    assert.equal(fake.state.recipients.at(-1).type, 'basa');

    const { id } = await book(customer);
    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    for (const status of ['en_route', 'arrived', 'in_progress']) await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
    assert.ok(!fake.state.transfers.some((t) => t.reason === `Job #${id}`), 'money is held until completion');

    const done = await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed', materialsCents: 25000 } });
    const labour = fake.state.transfers.find((t) => t.reason === `Job #${id}`);
    const expected = done.body.estimatedCents - Math.round(done.body.estimatedCents * 0.15);
    assert.equal(labour.amount, expected, 'upfront price minus the 15% fee');
    assert.equal(labour.currency, 'ZAR');
    assert.deepEqual(done.body.payouts, [{ kind: 'labour', amountCents: expected, status: 'processing', failureReason: null }]);

    // Customer approves the parts; the saved card is charged and the full amount goes to the pro.
    const parts = await call('POST', `/jobs/${id}/materials/payment`, { token: customer.token });
    assert.equal(parts.body.status, 'paid');
    assert.equal(parts.body.job.materialsStatus, 'paid');
    assert.equal(fake.state.transfers.find((t) => t.reason === `Job #${id} parts`).amount, 25000);
    assert.equal((await call('POST', `/jobs/${id}/materials/payment`, { token: customer.token })).status, 409);

    // Paystack confirms the transfer.
    assert.equal(await webhook({ event: 'transfer.success', data: { reference: labour.reference } }), 200);
    const payouts = await call('GET', '/provider/payouts', { token: pro.token });
    assert.equal(payouts.body.find((p) => p.jobId === id && p.kind === 'labour').status, 'paid');
  });

  test('parts fall back to checkout when the saved card is declined', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const { id } = await book(customer);
    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    for (const status of ['en_route', 'arrived', 'in_progress']) await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed', materialsCents: 5000 } });
    fake.state.savedCardStatus = 'failed';
    try {
      const parts = await call('POST', `/jobs/${id}/materials/payment`, { token: customer.token });
      assert.match(parts.body.authorizationUrl, /\/checkout\//);
      fake.pay(parts.body.reference);
      const job = await call('POST', `/jobs/${id}/payment/confirm`, { token: customer.token, body: { reference: parts.body.reference } });
      assert.equal(job.body.materialsStatus, 'paid');
    } finally {
      fake.state.savedCardStatus = 'success';
    }
  });

  test('payouts wait for bank details, and failed transfers can be retried', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const { id } = await book(customer);
    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    for (const status of ['en_route', 'arrived', 'in_progress', 'completed']) await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
    let payouts = (await call('GET', '/provider/payouts', { token: pro.token })).body;
    assert.equal(payouts[0].status, 'awaiting_details');

    fake.state.transferStatus = 'error';
    await call('PUT', '/provider/payout-account', { token: pro.token, body: { bankCode: '250655', accountNumber: '62000000001', accountName: 'Pro' } });
    payouts = (await call('GET', '/provider/payouts', { token: pro.token })).body;
    assert.equal(payouts[0].status, 'failed');
    assert.match(payouts[0].failureReason, /balance/);

    fake.state.transferStatus = 'success';
    payouts = (await call('POST', '/provider/payouts/retry', { token: pro.token })).body;
    assert.equal(payouts[0].status, 'paid');
    fake.state.transferStatus = 'pending';
  });

  test('rejects bad bank details', async () => {
    const pro = await onlinePro();
    const bad = await call('PUT', '/provider/payout-account', { token: pro.token, body: { bankCode: '470010', accountNumber: 'abc', accountName: 'X' } });
    assert.equal(bad.status, 400);
    const unknownBank = await call('PUT', '/provider/payout-account', { token: pro.token, body: { bankCode: '999', accountNumber: '123456789', accountName: 'X' } });
    assert.equal(unknownBank.status, 400);
  });

  test('other customers cannot pay for or confirm your job', async () => {
    const customer = await register('customer');
    const other = await register('customer');
    const created = await call('POST', '/jobs', { token: customer.token, body: jobBody() });
    assert.equal((await call('POST', `/jobs/${created.body.job.id}/payment`, { token: other.token })).status, 403);
    assert.equal((await call('POST', `/jobs/${created.body.job.id}/payment/confirm`, { token: other.token, body: { reference: created.body.payment.reference } })).status, 403);
  });
});

async function upload(token, kind, bytes, type = 'image/png') {
  const res = await fetch(`${base}/api/provider/documents/${kind}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: bytes,
  });
  return { status: res.status, body: await res.json() };
}
const admin = (method, path, body) => call(method, `/admin${path}`, { token: adminToken, body });

/** Runs a paid job up to (but not including) completion with an approved pro. */
async function jobInProgress() {
  const customer = await register('customer');
  const pro = await onlinePro();
  const { id, reference } = await book(customer);
  await call('POST', `/jobs/${id}/accept`, { token: pro.token });
  for (const status of ['en_route', 'arrived', 'in_progress']) await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
  return { customer, pro, id, reference };
}

describe('pro verification', () => {
  test('unverified pros cannot go online, see requests or accept jobs', async () => {
    const pro = await register('provider', { categories: ['plumbing'] });
    assert.equal(pro.user.provider.verificationStatus, 'unsubmitted');
    const online = await call('PATCH', '/provider/status', { token: pro.token, body: { online: true, ...HOME } });
    assert.equal(online.status, 403);

    db.prepare('UPDATE provider_profiles SET is_online = 1, lat = ?, lng = ? WHERE user_id = ?').run(HOME.lat, HOME.lng, pro.user.id);
    const customer = await register('customer');
    const { id } = await book(customer);
    assert.deepEqual((await call('GET', '/provider/requests', { token: pro.token })).body, []);
    assert.equal((await call('POST', `/jobs/${id}/accept`, { token: pro.token })).status, 403);
    assert.equal((await call('GET', `/jobs/${id}`, { token: pro.token })).status, 403);
  });

  test('upload, submit, reject with a reason, fix and get approved', async () => {
    const pro = await register('provider', { categories: ['electrical'] });
    const png = solidPng();

    // Only real images/PDFs are accepted, judged by content rather than the declared type.
    assert.equal((await upload(pro.token, 'id', Buffer.from('not really an image at all'), 'image/png')).status, 400);
    assert.equal((await upload(pro.token, 'selfie', Buffer.from('%PDF-1.4 fake pdf body'), 'application/pdf')).status, 400, 'selfie must be a photo');
    assert.equal((await upload(pro.token, 'passport', png)).status, 400);
    assert.equal((await upload(pro.token, 'id', Buffer.alloc(9 * 1024 * 1024, 1))).status, 413);

    assert.equal((await upload(pro.token, 'id', png)).status, 200);
    const early = await call('POST', '/provider/verification/submit', { token: pro.token });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /certificate/);

    await upload(pro.token, 'certificate', Buffer.from('%PDF-1.4 a trade certificate'), 'application/pdf');
    const status = await upload(pro.token, 'selfie', png);
    assert.deepEqual(status.body.missing, []);
    assert.equal((await call('POST', '/provider/verification/submit', { token: pro.token })).body.status, 'pending');
    assert.equal((await upload(pro.token, 'selfie', png)).status, 409, 'documents are locked while under review');

    // Who can see the documents.
    const docId = status.body.documents.find((d) => d.kind === 'id').id;
    const own = await fetch(`${base}/api/documents/${docId}`, { headers: { authorization: `Bearer ${pro.token}` } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    const stranger = await register('provider', { categories: ['cleaning'] });
    assert.equal((await fetch(`${base}/api/documents/${docId}`, { headers: { authorization: `Bearer ${stranger.token}` } })).status, 403);
    assert.equal((await fetch(`${base}/api/documents/${docId}`, { headers: { authorization: `Bearer ${adminToken}` } })).status, 200);

    // Only admins can decide.
    assert.equal((await call('POST', `/admin/providers/${pro.user.id}/verification`, { token: stranger.token, body: { decision: 'approve' } })).status, 403);
    const queue = await admin('GET', '/providers?status=pending');
    assert.ok(queue.body.some((p) => p.id === pro.user.id));
    assert.equal((await admin('POST', `/providers/${pro.user.id}/verification`, { decision: 'reject' })).status, 400, 'a reason is required');
    const rejected = await admin('POST', `/providers/${pro.user.id}/verification`, { decision: 'reject', note: 'ID photo is blurry' });
    assert.equal(rejected.body.verification.status, 'rejected');
    assert.equal((await call('GET', '/provider/verification', { token: pro.token })).body.note, 'ID photo is blurry');

    // Re-upload replaces the old file on disk instead of keeping both.
    const filesBefore = readdirSync(path.join(uploadDir, 'documents')).length;
    await upload(pro.token, 'id', solidPng(80, 60, [10, 20, 30]));
    assert.equal(readdirSync(path.join(uploadDir, 'documents')).length, filesBefore);
    assert.equal((await fetch(`${base}/api/documents/${docId}`, { headers: { authorization: `Bearer ${adminToken}` } })).status, 404);

    await call('POST', '/provider/verification/submit', { token: pro.token });
    const approved = await admin('POST', `/providers/${pro.user.id}/verification`, { decision: 'approve' });
    assert.equal(approved.body.verification.status, 'approved');
    const online = await call('PATCH', '/provider/status', { token: pro.token, body: { online: true, ...HOME } });
    assert.equal(online.status, 200);

    // Suspending an approved pro takes them offline.
    await admin('POST', `/providers/${pro.user.id}/verification`, { decision: 'reject', note: 'Licence expired' });
    assert.equal((await call('GET', '/me', { token: pro.token })).body.provider.online, false);
  });

  test('admin accounts cannot be created through sign-up', async () => {
    const res = await call('POST', '/auth/register', { body: { role: 'admin', name: 'x', email: 'sneaky@x.com', password: 'password123' } });
    assert.equal(res.status, 400);
  });

  test('admin routes are admin-only', async () => {
    const customer = await register('customer');
    assert.equal((await call('GET', '/admin/overview', { token: customer.token })).status, 403);
    assert.equal((await call('GET', '/admin/overview')).status, 401);
    const overview = await admin('GET', '/overview');
    assert.equal(typeof overview.body.pendingVerifications, 'number');
  });

  test('repeated failed logins are throttled', async () => {
    const { user } = await register('customer');
    for (let i = 0; i < 10; i++) await call('POST', '/auth/login', { body: { email: user.email, password: 'wrong' } });
    const blocked = await call('POST', '/auth/login', { body: { email: user.email, password: 'password123' } });
    assert.equal(blocked.status, 429);
  });
});

describe('disputes and refunds', () => {
  test('a dispute holds the payout; resolving with a partial refund releases the rest', async () => {
    const { customer, pro, id, reference } = await jobInProgress();
    await call('PUT', '/provider/payout-account', { token: pro.token, body: { bankCode: '470010', accountNumber: '1234567890', accountName: 'Pro' } });

    const opened = await call('POST', `/jobs/${id}/disputes`, { token: customer.token, body: { reason: 'quality', details: 'Still leaking' } });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.dispute.status, 'open');
    assert.equal((await call('POST', `/jobs/${id}/disputes`, { token: customer.token, body: { reason: 'other' } })).status, 409);

    const done = await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed' } });
    assert.equal(done.body.payouts[0].status, 'on_hold');
    assert.ok(!fake.state.transfers.some((t) => t.reason === `Job #${id}`), 'nothing is sent while disputed');

    const disputes = await admin('GET', '/disputes');
    const dispute = disputes.body.find((d) => d.jobId === id);
    assert.equal(dispute.reasonLabel, 'Work not done properly');

    assert.equal((await admin('POST', `/disputes/${dispute.id}/resolve`, { refundCents: 20000, payoutAction: 'release' })).status, 400, 'note required');
    const resolved = await admin('POST', `/disputes/${dispute.id}/resolve`, { refundCents: 20000, payoutAction: 'release', note: 'Partial refund for return visit' });
    assert.equal(resolved.status, 200);
    assert.deepEqual(fake.state.refundLog.filter((r) => r.transaction === reference), [{ transaction: reference, amount: 20000 }]);
    assert.equal(resolved.body.payouts[0].status, 'processing');
    assert.equal(resolved.body.refunds[0].amountCents, 20000);
    assert.equal((await admin('POST', `/disputes/${dispute.id}/resolve`, { payoutAction: 'release', note: 'again' })).status, 409);

    const seen = await call('GET', `/jobs/${id}`, { token: customer.token });
    assert.equal(seen.body.dispute.status, 'resolved');
    assert.equal(seen.body.dispute.resolutionNote, 'Partial refund for return visit');
    assert.equal(seen.body.refundedCents, 20000);
  });

  test('resolving with a full refund can cancel the payout', async () => {
    const { customer, pro, id, reference } = await jobInProgress();
    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed' } });
    // The pro has no bank account, so the payout is still unsent and can be held.
    await call('POST', `/jobs/${id}/disputes`, { token: customer.token, body: { reason: 'no_show' } });
    const detail = await admin('GET', `/jobs/${id}`);
    assert.equal(detail.body.payouts[0].status, 'on_hold');
    const dispute = detail.body.disputes[0];
    const resolved = await admin('POST', `/disputes/${dispute.id}/resolve`, {
      refundCents: detail.body.refundableCents, payoutAction: 'cancel', note: 'Pro left before finishing',
    });
    assert.equal(resolved.body.payouts[0].status, 'cancelled');
    assert.equal(resolved.body.job.paymentStatus, 'refund_pending');
    assert.ok(fake.state.refunds.includes(reference));

    // Adding a bank account later must not send a cancelled payout.
    await call('PUT', '/provider/payout-account', { token: pro.token, body: { bankCode: '470010', accountNumber: '1234567890', accountName: 'Pro' } });
    assert.ok(!fake.state.transfers.some((t) => t.reason === `Job #${id}`));
  });

  test('who can dispute, and when', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const { id } = await book(customer);
    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    assert.equal((await call('POST', `/jobs/${id}/disputes`, { token: customer.token, body: { reason: 'quality' } })).status, 409, 'too early');
    const outsider = await register('customer');
    assert.equal((await call('POST', `/jobs/${id}/disputes`, { token: outsider.token, body: { reason: 'quality' } })).status, 403);
    assert.equal((await call('POST', `/jobs/${id}/disputes`, { token: customer.token, body: { reason: 'made-up' } })).status, 400);
    // Admins can flag any job.
    assert.equal((await admin('POST', `/jobs/${id}/disputes`, { reason: 'conduct', details: 'Reported by phone' })).status, 201);
  });

  test('admins can refund part of a job, but never more than was paid', async () => {
    const customer = await register('customer');
    const { id, reference } = await book(customer);
    const detail = await admin('GET', `/jobs/${id}`);
    const paid = detail.body.refundableCents;
    assert.equal((await admin('POST', `/jobs/${id}/refunds`, { amountCents: 5000 })).status, 400, 'reason required');
    const partial = await admin('POST', `/jobs/${id}/refunds`, { amountCents: 5000, reason: 'Goodwill' });
    assert.equal(partial.body.refundableCents, paid - 5000);
    assert.equal(partial.body.job.paymentStatus, 'paid', 'a partial refund leaves the booking paid');
    assert.equal((await admin('POST', `/jobs/${id}/refunds`, { amountCents: paid, reason: 'Too much' })).status, 400);

    const rest = await admin('POST', `/jobs/${id}/refunds`, { amountCents: paid - 5000, reason: 'Customer cancelled by phone' });
    assert.equal(rest.body.refundableCents, 0);
    assert.equal(rest.body.refunds.length, 2);
    assert.equal(rest.body.refunds[0].createdBy, 'Ops');

    for (const r of fake.state.refundLog.filter((x) => x.transaction === reference)) {
      assert.equal(await webhook({ event: 'refund.processed', data: { transaction_reference: reference } }), 200, String(r.amount));
    }
    const after = await admin('GET', `/jobs/${id}`);
    assert.deepEqual(after.body.refunds.map((r) => r.status), ['processed', 'processed']);
    assert.equal(after.body.job.paymentStatus, 'refunded');
  });

  test('admin job search and filters', async () => {
    const { id } = await jobInProgress();
    const byId = await admin('GET', `/jobs?q=%23${id}`);
    assert.deepEqual(byId.body.jobs.map((j) => j.id), [id]);
    const active = await admin('GET', '/jobs?status=active');
    assert.ok(active.body.jobs.some((j) => j.id === id));
    const completed = await admin('GET', '/jobs?status=completed');
    assert.ok(!completed.body.jobs.some((j) => j.id === id));
  });
});

const browserSubscription = (endpoint = `https://push.test/${randomBytes(6).toString('hex')}`) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};

describe('notifications', () => {
  test('key job events reach the customer in-app, by push and by SMS', async () => {
    const customer = await register('customer', { phone: '082 555 1234' });
    const sub = browserSubscription();
    assert.equal((await call('POST', '/push/subscriptions', { token: customer.token, body: sub })).status, 201);
    const pro = await onlinePro();
    const proSub = browserSubscription();
    await call('POST', '/push/subscriptions', { token: pro.token, body: proSub });

    const { id } = await book(customer);
    await notifier.idle();
    const offer = pushed.find((p) => p.endpoint === proSub.endpoint);
    assert.match(offer.payload.title, /New plumbing request/);
    assert.match(offer.payload.body, /you'd earn R/);
    // A real, encrypted Web Push request.
    assert.equal(offer.headers['Content-Encoding'], 'aes128gcm');
    assert.match(offer.headers.Authorization, /^vapid t=.+, k=/);

    const smsBefore = sentSms.length;
    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'en_route' } });
    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'arrived' } });
    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'in_progress' } });
    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed' } });
    await notifier.idle();

    // SMS only for the three key moments, to the normalised number, with a link back to the job.
    const texts = sentSms.slice(smsBefore);
    assert.equal(texts.length, 3);
    assert.ok(texts.every((m) => m.to === '+27825551234'));
    assert.match(texts[0].body, /accepted your plumbing job/);
    assert.match(texts[1].body, /is on the way and should arrive in about \d+ min/);
    assert.match(texts[2].body, /job is done\. Total R\d/);
    assert.ok(texts.every((m) => m.body.includes(`/jobs/${id}`)));
    assert.ok(texts.every((m) => /^[\x20-\x7e]+$/.test(m.body)), 'plain ASCII so the SMS stays in one segment');

    const inbox = await call('GET', '/notifications', { token: customer.token });
    assert.deepEqual(inbox.body.items.slice(0, 4).map((n) => n.type), ['job_completed', 'pro_arrived', 'pro_en_route', 'job_accepted']);
    assert.equal(inbox.body.items[0].url, `/jobs/${id}`);
    assert.ok(inbox.body.unread >= 4);
    assert.ok(pushed.filter((p) => p.endpoint === sub.endpoint).length >= 4);

    const read = await call('POST', '/notifications/read', { token: customer.token, body: { ids: [inbox.body.items[0].id] } });
    assert.equal(read.body.unread, inbox.body.unread - 1);
    assert.equal((await call('POST', '/notifications/read', { token: customer.token, body: { all: true } })).body.unread, 0);

    const detail = await admin('GET', `/jobs/${id}`);
    assert.deepEqual(detail.body.sms.map((s) => [s.type, s.status]), [['job_accepted', 'sent'], ['pro_en_route', 'sent'], ['job_completed', 'sent']]);
  });

  test('no SMS when the user opts out or has no usable number', async () => {
    const optedOut = await register('customer', { phone: '0825550000' });
    assert.equal((await call('PATCH', '/me', { token: optedOut.token, body: { smsEnabled: false } })).body.smsEnabled, false);
    const noPhone = await register('customer', { phone: '' });
    const pro = await onlinePro();
    const before = sentSms.length;
    for (const customer of [optedOut, noPhone]) {
      const { id } = await book(customer);
      await call('POST', `/jobs/${id}/accept`, { token: pro.token });
      await call('POST', `/jobs/${id}/cancel`, { token: pro.token });
    }
    await notifier.idle();
    assert.equal(sentSms.length, before);
    // ...but they still get it in the app.
    assert.ok((await call('GET', '/notifications', { token: optedOut.token })).body.items.some((n) => n.type === 'job_accepted'));
    // The pro dropping out tells the customer.
    assert.ok((await call('GET', '/notifications', { token: noPhone.token })).body.items.some((n) => n.type === 'job_released'));
  });

  test('phone numbers are validated when saved', async () => {
    const customer = await register('customer');
    assert.equal((await call('PATCH', '/me', { token: customer.token, body: { phone: '12' } })).status, 400);
    const ok = await call('PATCH', '/me', { token: customer.token, body: { phone: '+27 82 123 4567' } });
    assert.equal(ok.body.phone, '+27 82 123 4567');
  });

  test('chat messages are pushed to the other party only', async () => {
    const { customer, pro, id } = await jobInProgress();
    const customerSub = browserSubscription();
    const proSub = browserSubscription();
    await call('POST', '/push/subscriptions', { token: customer.token, body: customerSub });
    await call('POST', '/push/subscriptions', { token: pro.token, body: proSub });
    await call('POST', `/jobs/${id}/messages`, { token: customer.token, body: { body: 'Gate code is 4321' } });
    await notifier.idle();
    const toPro = pushed.filter((p) => p.endpoint === proSub.endpoint);
    assert.deepEqual(toPro.at(-1).payload, { title: customer.user.name, body: 'Gate code is 4321', url: `/jobs/${id}`, tag: `chat-${id}` });
    assert.ok(!pushed.some((p) => p.endpoint === customerSub.endpoint && p.payload.tag === `chat-${id}`));
  });

  test('push subscriptions: only real push services, and dead ones are cleaned up', async () => {
    const customer = await register('customer');
    const internal = browserSubscription('http://169.254.169.254/latest/meta-data');
    assert.equal((await call('POST', '/push/subscriptions', { token: customer.token, body: internal })).status, 400);
    assert.equal((await call('POST', '/push/subscriptions', { token: customer.token, body: { endpoint: 'https://push.test/x' } })).status, 400);

    const sub = browserSubscription();
    await call('POST', '/push/subscriptions', { token: customer.token, body: sub });
    goneEndpoints.add(sub.endpoint);
    const pro = await onlinePro();
    const { id } = await book(customer);
    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    await notifier.idle();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint).n, 0);

    const again = browserSubscription();
    await call('POST', '/push/subscriptions', { token: customer.token, body: again });
    await call('DELETE', '/push/subscriptions', { token: customer.token, body: { endpoint: again.endpoint } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(again.endpoint).n, 0);
  });

  test('pros hear about payouts and verification; both sides hear about disputes and refunds', async () => {
    const { customer, pro, id } = await jobInProgress();
    await call('PUT', '/provider/payout-account', { token: pro.token, body: { bankCode: '470010', accountNumber: '1234567890', accountName: 'Pro' } });
    fake.state.transferStatus = 'success';
    try {
      await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed' } });
    } finally {
      fake.state.transferStatus = 'pending';
    }
    await call('POST', `/jobs/${id}/disputes`, { token: customer.token, body: { reason: 'quality' } });
    const dispute = (await admin('GET', `/jobs/${id}`)).body.disputes[0];
    await admin('POST', `/disputes/${dispute.id}/resolve`, { refundCents: 10000, payoutAction: 'release', note: 'Goodwill refund' });
    await notifier.idle();

    const types = async (u) => (await call('GET', '/notifications', { token: u.token })).body.items.map((n) => n.type);
    const proTypes = await types(pro);
    assert.ok(proTypes.includes('payout_paid'));
    assert.ok(proTypes.includes('dispute_opened'));
    assert.ok(proTypes.includes('dispute_resolved'));
    const customerTypes = await types(customer);
    assert.ok(customerTypes.includes('refund_issued'));
    assert.ok(customerTypes.includes('dispute_resolved'));
    assert.ok(!customerTypes.includes('dispute_opened'), 'the person who reported it is not told about their own report');
  });
});

// Pretoria is about 55 km from the Johannesburg test location.
const PRETORIA = { lat: -25.7479, lng: 28.2293 };
const MON_9_17 = { mon: { start: '09:00', end: '17:00' } };
const feedIds = async (pro) => (await call('GET', '/provider/requests', { token: pro.token })).body.map((j) => j.id);

describe('pro availability: hours, service area and trades', () => {
  test('jobs are only offered inside working hours (for scheduled jobs, at the booked time)', async () => {
    const pro = await onlinePro(['pest-control']);
    assert.equal((await call('PUT', '/provider/hours', { token: pro.token, body: { workingHours: MON_9_17 } })).status, 200);
    const customer = await register('customer');
    try {
      clockTime = '2026-10-12T08:00:00Z'; // Monday 10:00 in Johannesburg
      const est = await call('POST', '/estimate', { token: customer.token, body: jobBody({ categoryId: 'pest-control' }) });
      assert.ok(est.body.availableProviders >= 1);
      const { id: daytime } = await book(customer, { categoryId: 'pest-control' });
      assert.ok((await feedIds(pro)).includes(daytime));
      assert.equal((await call('GET', '/me', { token: pro.token })).body.provider.availability.withinHours, true);

      clockTime = '2026-10-12T16:00:00Z'; // Monday 18:00, after hours
      assert.ok(!(await feedIds(pro)).includes(daytime), 'an ASAP job is not shown once the pro is off shift');
      const after = await call('POST', '/estimate', { token: customer.token, body: jobBody({ categoryId: 'pest-control' }) });
      assert.equal(after.body.availableProviders, 0);
      assert.deepEqual((await call('GET', '/me', { token: pro.token })).body.provider.availability, { withinHours: false, hoursToday: '09:00-17:00' });

      // Requested on Sunday for Monday 11:00: matched against Monday's hours.
      clockTime = '2026-10-18T10:00:00Z';
      const { id: scheduled } = await book(customer, { categoryId: 'pest-control', scheduledFor: '2026-10-19T09:00:00Z' });
      assert.ok((await feedIds(pro)).includes(scheduled));
      const { id: sundayAsap } = await book(customer, { categoryId: 'pest-control' });
      assert.ok(!(await feedIds(pro)).includes(sundayAsap));
    } finally {
      clockTime = null;
    }
    // "Any time" again.
    await call('PUT', '/provider/hours', { token: pro.token, body: { workingHours: null } });
    assert.equal((await call('GET', '/provider/settings', { token: pro.token })).body.workingHours, null);
  });

  test('working hours are validated', async () => {
    const pro = await onlinePro(['pest-control']);
    const bad = (workingHours) => call('PUT', '/provider/hours', { token: pro.token, body: { workingHours } });
    assert.equal((await bad({ mon: { start: '9', end: '17:00' } })).status, 400);
    assert.equal((await bad({ mon: null, tue: null })).status, 400, 'at least one day');
    assert.equal((await bad({ fri: { start: '22:00', end: '06:00' } })).status, 200, 'overnight is fine');
  });

  test('jobs are only offered inside the service area', async () => {
    const pro = await onlinePro(['appliances']); // live location is in Johannesburg
    const customer = await register('customer');
    const { id } = await book(customer, { categoryId: 'appliances' });
    assert.ok((await feedIds(pro)).includes(id), 'default: around the live location');

    const area = (serviceArea) => call('PUT', '/provider/service-area', { token: pro.token, body: { serviceArea } });
    assert.equal((await area({ ...PRETORIA, radiusKm: 0 })).status, 400);
    assert.equal((await area({ ...PRETORIA, radiusKm: 500 })).status, 400);
    assert.equal((await area({ lat: 'x', lng: 1, radiusKm: 10 })).status, 400);

    assert.deepEqual((await area({ ...PRETORIA, radiusKm: 15 })).body.serviceArea, { ...PRETORIA, radiusKm: 15 });
    assert.ok(!(await feedIds(pro)).includes(id), 'a Johannesburg job is outside a 15 km Pretoria area');
    const est = await call('POST', '/estimate', { token: customer.token, body: jobBody({ categoryId: 'appliances' }) });
    assert.ok(!est.body.nearby.some((p) => Math.abs(p.lat - HOME.lat - 0.01) < 0.003), 'not counted as nearby either');

    await area({ ...PRETORIA, radiusKm: 70 });
    assert.ok((await feedIds(pro)).includes(id));
    await area(null);
    assert.equal((await call('GET', '/provider/settings', { token: pro.token })).body.serviceArea, null);
  });

  test('a verified pro can add trades, but new ones need admin approval', async () => {
    const pro = await onlinePro(['painting']);
    const customer = await register('customer');
    const { id } = await book(customer, { categoryId: 'gardening' });

    const updated = await call('PUT', '/provider/trades', { token: pro.token, body: { categories: ['painting', 'gardening', 'nonsense'] } });
    assert.deepEqual(updated.body.trades, [{ id: 'painting', status: 'approved' }, { id: 'gardening', status: 'pending' }]);
    assert.deepEqual((await call('GET', '/me', { token: pro.token })).body.provider.pendingCategories, ['gardening']);
    assert.ok(!(await feedIds(pro)).includes(id));
    assert.equal((await call('POST', `/jobs/${id}/accept`, { token: pro.token })).status, 403);

    const queue = await admin('GET', '/providers?status=pending');
    assert.deepEqual(queue.body.find((p) => p.id === pro.user.id)?.pendingCategories, ['gardening']);
    const decided = await admin('POST', `/providers/${pro.user.id}/trades`, { decision: 'approve' });
    assert.deepEqual(decided.body.pendingCategories, []);
    assert.ok((await feedIds(pro)).includes(id));

    // Removing trades, and rejecting a new one.
    await call('PUT', '/provider/trades', { token: pro.token, body: { categories: ['gardening', 'cleaning'] } });
    await admin('POST', `/providers/${pro.user.id}/trades`, { decision: 'reject' });
    assert.deepEqual((await call('GET', '/provider/settings', { token: pro.token })).body.trades, [{ id: 'gardening', status: 'approved' }]);
    assert.equal((await call('PUT', '/provider/trades', { token: pro.token, body: { categories: [] } })).status, 400);
    await notifier.idle();
    const types = (await call('GET', '/notifications', { token: pro.token })).body.items.map((n) => n.type);
    assert.ok(types.includes('trades_approved') && types.includes('trades_rejected'));
  });

  test('a new pro\'s trades are approved together with their verification', async () => {
    const pro = await register('provider', { categories: ['locksmith', 'handyman'] });
    assert.deepEqual(pro.user.provider.categories, []);
    assert.deepEqual(pro.user.provider.pendingCategories, ['locksmith', 'handyman']);
    db.prepare("INSERT INTO provider_documents (user_id, kind, file_name, mime, size_bytes) VALUES (?, 'id', 'x', 'image/png', 1), (?, 'certificate', 'y', 'image/png', 1), (?, 'selfie', 'z', 'image/png', 1)")
      .run(pro.user.id, pro.user.id, pro.user.id);
    await admin('POST', `/providers/${pro.user.id}/verification`, { decision: 'approve' });
    assert.deepEqual((await call('GET', '/me', { token: pro.token })).body.provider.categories, ['locksmith', 'handyman']);
  });
});

describe('earnings dashboard', () => {
  test('today, this week and this month, with fees, a daily series and payout history', async () => {
    const pro = await onlinePro(['hvac']);
    await call('PUT', '/provider/payout-account', { token: pro.token, body: { bankCode: '470010', accountNumber: '1234567890', accountName: 'Pro' } });
    const customer = await register('customer');
    const finish = async (completedAt) => {
      const { id } = await book(customer, { categoryId: 'hvac' });
      await call('POST', `/jobs/${id}/accept`, { token: pro.token });
      for (const status of ['en_route', 'arrived', 'in_progress', 'completed']) await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
      db.prepare('UPDATE jobs SET completed_at = ? WHERE id = ?').run(completedAt, id);
      return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    };
    // "Now" is Thursday 15 October 2026, 10:00 in Johannesburg.
    const today = await finish('2026-10-15 06:00:00'); // today 08:00
    const monday = await finish('2026-10-12 08:00:00'); // this week
    const lastMonth = await finish('2026-09-30 21:59:00'); // 23:59 on 30 Sept: last month, but in the 30-day chart
    const cancelled = await finish('2026-10-15 07:00:00'); // payout cancelled after a dispute
    db.prepare("UPDATE payouts SET status = 'cancelled' WHERE job_id = ?").run(cancelled.id);

    try {
      clockTime = '2026-10-15T08:00:00Z';
      const { body } = await call('GET', '/provider/earnings', { token: pro.token });
      const earned = (j) => j.payout_cents;
      assert.deepEqual(body.periods.today, {
        earningsCents: earned(today), jobs: 2, feesCents: today.platform_fee_cents + cancelled.platform_fee_cents,
        customerPaidCents: today.final_cents + cancelled.final_cents,
      });
      assert.equal(body.periods.week.earningsCents, earned(today) + earned(monday));
      assert.equal(body.periods.week.jobs, 3);
      assert.equal(body.periods.month.jobs, 3, 'the 30 September job belongs to last month');
      assert.equal(body.allTime.jobs, 4);
      assert.equal(body.allTime.earningsCents, earned(today) + earned(monday) + earned(lastMonth));

      assert.equal(body.daily.length, 30);
      assert.equal(body.daily.at(-1).date, '2026-10-15');
      assert.equal(body.daily.at(-1).earningsCents, earned(today));
      assert.equal(body.daily.find((d) => d.date === '2026-09-30').earningsCents, earned(lastMonth));

      assert.equal(body.recentJobs.length, 4);
      assert.equal(body.recentJobs.find((j) => j.id === cancelled.id).payoutStatus, 'cancelled');
      assert.equal(body.recentJobs.find((j) => j.id === today.id).feeCents, today.platform_fee_cents);
      assert.equal(body.payouts.pendingCents, earned(today) + earned(monday) + earned(lastMonth), 'transfers still processing');
    } finally {
      clockTime = null;
    }
  });
});

/** A completed, paid job between this customer and pro. */
async function completedJob(customer, pro, extra = {}) {
  const { id } = await book(customer, extra);
  await call('POST', `/jobs/${id}/accept`, { token: pro.token });
  for (const status of ['en_route', 'arrived', 'in_progress']) await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
  await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed', materialsCents: extra.materialsCents ?? 0 } });
  return id;
}
async function pdf(path, token) {
  const res = await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), bytes: Buffer.from(await res.arrayBuffer()) };
}

describe('invoices', () => {
  test('a completed job has a numbered PDF invoice for its customer', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const id = await completedJob(customer, pro);
    const inv = await call('GET', `/jobs/${id}/invoice`, { token: customer.token });
    assert.equal(inv.status, 200);
    assert.match(inv.body.number, /^INV-\d{4}-\d{5}$/);
    assert.equal(inv.body.vat.enabled, false);
    assert.equal(inv.body.lines.length, 1);
    assert.equal(inv.body.paidCents, inv.body.totalCents);
    assert.equal(inv.body.customer.email, customer.user.email);

    const file = await pdf(`/jobs/${id}/invoice.pdf`, customer.token);
    assert.equal(file.status, 200);
    assert.equal(file.type, 'application/pdf');
    assert.match(file.disposition, new RegExp(`${inv.body.number}\\.pdf`));
    assert.equal(file.bytes.subarray(0, 5).toString(), '%PDF-');
    assert.match(file.bytes.subarray(-8).toString(), /%%EOF/);

    // Same invoice every time.
    assert.equal((await call('GET', `/jobs/${id}/invoice`, { token: customer.token })).body.number, inv.body.number);
    // Only the customer (and admins).
    assert.equal((await pdf(`/jobs/${id}/invoice.pdf`, pro.token)).status, 403);
    assert.equal((await call('GET', `/jobs/${id}/invoice`, { token: (await register('customer')).token })).status, 403);
    assert.equal((await pdf(`/jobs/${id}/invoice.pdf`, adminToken)).status, 200);
  });

  test('no invoice before the job is done, or while parts are unpaid', async () => {
    const { customer, id } = await jobInProgress();
    assert.equal((await call('GET', `/jobs/${id}/invoice`, { token: customer.token })).status, 409);
    const pro = await onlinePro();
    const withParts = await completedJob(customer, pro, { materialsCents: 5000 });
    const blocked = await call('GET', `/jobs/${withParts}/invoice`, { token: customer.token });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /parts/);
    await call('POST', `/jobs/${withParts}/materials/payment`, { token: customer.token });
    const inv = await call('GET', `/jobs/${withParts}/invoice`, { token: customer.token });
    assert.deepEqual(inv.body.lines.map((l) => l.amountCents).slice(1), [5000]);
  });

  test('VAT can be switched on; issued invoices never change', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const before = await completedJob(customer, pro);
    const old = await call('GET', `/jobs/${before}/invoice`, { token: customer.token });

    assert.equal((await call('PUT', '/admin/settings', { token: customer.token, body: { vatEnabled: true } })).status, 403);
    assert.equal((await admin('PUT', '/settings', { vatEnabled: true })).status, 400, 'a VAT number is required');
    assert.equal((await admin('PUT', '/settings', { vatEnabled: true, vatNumber: '123' })).status, 400);
    const saved = await admin('PUT', '/settings', { vatEnabled: true, vatNumber: '4123456789', businessName: 'ProNow (Pty) Ltd', businessAddress: '1 Main Rd, Johannesburg' });
    assert.equal(saved.body.vatEnabled, true);

    const after = await completedJob(customer, pro);
    const inv = await call('GET', `/jobs/${after}/invoice`, { token: customer.token });
    assert.deepEqual(inv.body.vat, { enabled: true, rate: 15, number: '4123456789', includedCents: Math.round((inv.body.paidCents * 15) / 115) });
    assert.equal(inv.body.business.name, 'ProNow (Pty) Ltd');
    assert.ok(inv.body.number > old.body.number, 'numbers go up');
    assert.deepEqual((await call('GET', `/jobs/${before}/invoice`, { token: customer.token })).body, old.body, 'the earlier invoice is unchanged');

    await admin('PUT', '/settings', { vatEnabled: false });
    assert.equal((await call('GET', `/jobs/${after}/invoice`, { token: customer.token })).body.vat.enabled, true, 'still a tax invoice');
  });

  test('refunds made before the invoice is issued are shown on it', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const id = await completedJob(customer, pro);
    await admin('POST', `/jobs/${id}/refunds`, { amountCents: 10000, reason: 'Late arrival' });
    const inv = await call('GET', `/jobs/${id}/invoice`, { token: customer.token });
    assert.equal(inv.body.refundedCents, 10000);
    assert.equal(inv.body.paidCents, inv.body.totalCents - 10000);
    assert.equal(inv.body.refunds.length, 1);
  });
});

describe('book again and favourites', () => {
  test('the chosen pro gets first refusal, then everyone', async () => {
    const customer = await register('customer');
    const sipho = await onlinePro(['cleaning']);
    await completedJob(customer, sipho, { categoryId: 'cleaning' });
    const other = await onlinePro(['cleaning']);

    const est = await call('POST', '/estimate', { token: customer.token, body: jobBody({ categoryId: 'cleaning', preferredProviderId: sipho.user.id }) });
    assert.deepEqual(est.body.preferred, { id: sipho.user.id, name: sipho.user.name, available: true });

    try {
      clockTime = new Date().toISOString();
      const { id } = await book(customer, { categoryId: 'cleaning', preferredProviderId: sipho.user.id });
      const job = await call('GET', `/jobs/${id}`, { token: customer.token });
      assert.equal(job.body.preferredProvider.id, sipho.user.id);
      assert.ok(job.body.preferredProvider.reservedUntil);
      assert.ok((await feedIds(sipho)).includes(id));
      assert.ok(!(await feedIds(other)).includes(id), 'reserved for the chosen pro');
      assert.equal((await call('POST', `/jobs/${id}/accept`, { token: other.token })).status, 409);
      assert.equal((await call('GET', '/provider/requests', { token: sipho.token })).body.find((j) => j.id === id).askedForYou, true);

      // Window passes: everyone gets it, and the customer is told.
      clockTime = new Date(Date.now() + 6 * 60000).toISOString();
      await runScheduler();
      assert.ok((await feedIds(other)).includes(id));
      await notifier.idle();
      assert.ok((await call('GET', '/notifications', { token: customer.token })).body.items.some((n) => n.type === 'preferred_unavailable'));
      assert.equal((await call('POST', `/jobs/${id}/accept`, { token: other.token })).status, 200);
    } finally {
      clockTime = null;
    }
  });

  test('if the chosen pro is unavailable the job goes to everyone straight away', async () => {
    const customer = await register('customer');
    const sipho = await onlinePro(['cleaning']);
    await completedJob(customer, sipho, { categoryId: 'cleaning' });
    await call('PATCH', '/provider/status', { token: sipho.token, body: { online: false } });
    const other = await onlinePro(['cleaning']);
    const est = await call('POST', '/estimate', { token: customer.token, body: jobBody({ categoryId: 'cleaning', preferredProviderId: sipho.user.id }) });
    assert.equal(est.body.preferred.available, false);
    const { id } = await book(customer, { categoryId: 'cleaning', preferredProviderId: sipho.user.id });
    assert.ok((await feedIds(other)).includes(id));
  });

  test('you can only rebook or save pros who have worked for you', async () => {
    const customer = await register('customer');
    const stranger = await onlinePro(['cleaning']);
    const created = await call('POST', '/jobs', { token: customer.token, body: jobBody({ categoryId: 'cleaning', preferredProviderId: stranger.user.id }) });
    assert.equal(created.status, 400);
    assert.equal((await call('PUT', `/favourites/${stranger.user.id}`, { token: customer.token })).status, 400);

    const pro = await onlinePro(['cleaning']);
    await completedJob(customer, pro, { categoryId: 'cleaning' });
    const wrongTrade = await call('POST', '/jobs', { token: customer.token, body: jobBody({ categoryId: 'electrical', preferredProviderId: pro.user.id }) });
    assert.equal(wrongTrade.status, 400);
    assert.match(wrongTrade.body.error, /doesn't offer/);
  });

  test('favourite pros', async () => {
    const customer = await register('customer');
    const pro = await onlinePro(['cleaning', 'gardening']);
    const jobId = await completedJob(customer, pro, { categoryId: 'cleaning' });
    const added = await call('PUT', `/favourites/${pro.user.id}`, { token: customer.token });
    assert.equal(added.status, 200);
    await call('PUT', `/favourites/${pro.user.id}`, { token: customer.token }); // idempotent
    const list = (await call('GET', '/favourites', { token: customer.token })).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, pro.user.id);
    assert.deepEqual(list[0].categories, ['cleaning', 'gardening']);
    assert.equal(list[0].jobsTogether, 1);
    assert.equal(list[0].lastJobId, jobId);
    assert.equal(list[0].verified, true);
    assert.deepEqual((await call('DELETE', `/favourites/${pro.user.id}`, { token: customer.token })).body, []);
    assert.equal((await call('GET', '/favourites', { token: pro.token })).status, 403);
  });
});

describe('repeat bookings', () => {
  const recurringBody = (extra = {}) => ({ ...jobBody({ categoryId: 'gardening', description: 'Mow the lawn' }), frequency: 'weekly', ...extra });

  test('weekly: first visit through checkout, later visits booked ahead on the saved card', async () => {
    const customer = await register('customer');
    const gardener = await onlinePro(['gardening']);
    try {
      clockTime = '2026-10-15T08:00:00Z'; // Thursday 10:00 in Johannesburg
      const created = await call('POST', '/recurring', { token: customer.token, body: recurringBody({ firstVisitAt: '2026-10-19T07:00:00Z' }) });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.recurring.frequencyLabel, 'Every week');
      assert.equal(created.body.recurring.localTime, '09:00');
      assert.equal(created.body.recurring.nextVisitAt, '2026-10-26T07:00:00.000Z');
      // First visit is paid through checkout, which also saves the card.
      fake.pay(created.body.payment.reference);
      const first = await call('POST', `/jobs/${created.body.job.id}/payment/confirm`, { token: customer.token, body: { reference: created.body.payment.reference } });
      assert.equal(first.body.status, 'requested');
      assert.equal(first.body.recurringId, created.body.recurring.id);
      assert.equal(first.body.scheduledFor, '2026-10-19T07:00:00.000Z');

      // Not yet within 48 hours of the next visit.
      assert.equal(await runScheduler().then(() => db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE recurring_id = ?').get(created.body.recurring.id).n), 1);

      clockTime = '2026-10-24T08:00:00Z'; // two days before the 26th
      await runScheduler();
      await runScheduler(); // a second run must not book it twice
      const jobs = db.prepare('SELECT * FROM jobs WHERE recurring_id = ? ORDER BY id').all(created.body.recurring.id);
      assert.equal(jobs.length, 2);
      assert.equal(jobs[1].scheduled_for, '2026-10-26T07:00:00.000Z');
      assert.equal(jobs[1].status, 'requested', 'charged to the saved card and sent to pros');
      assert.equal(jobs[1].surge, 1);
      assert.ok((await feedIds(gardener)).includes(jobs[1].id));
      await notifier.idle();
      const note = (await call('GET', '/notifications', { token: customer.token })).body.items.find((n) => n.type === 'recurring_booked');
      assert.match(note.body, /Mon,? 26 Oct,? 09:00\. R\d+ was charged to your saved card/);

      const list = (await call('GET', '/recurring', { token: customer.token })).body;
      assert.equal(list[0].nextVisitAt, '2026-11-02T07:00:00.000Z');
      assert.equal(list[0].upcomingJobs.length, 2);
    } finally {
      clockTime = null;
    }
  });

  test('a declined saved card leaves the visit waiting for payment and tells the customer', async () => {
    const customer = await register('customer');
    try {
      clockTime = '2026-10-15T08:00:00Z';
      const created = await call('POST', '/recurring', { token: customer.token, body: recurringBody({ firstVisitAt: '2026-10-16T07:00:00Z' }) });
      fake.pay(created.body.payment.reference);
      await call('POST', `/jobs/${created.body.job.id}/payment/confirm`, { token: customer.token, body: { reference: created.body.payment.reference } });
      fake.state.savedCardStatus = 'failed';
      clockTime = '2026-10-21T08:00:00Z';
      await runScheduler();
      const visit = db.prepare('SELECT * FROM jobs WHERE recurring_id = ? ORDER BY id DESC').get(created.body.recurring.id);
      assert.equal(visit.status, 'awaiting_payment');
      await notifier.idle();
      assert.ok((await call('GET', '/notifications', { token: customer.token })).body.items.some((n) => n.type === 'recurring_payment_needed' && n.jobId === visit.id));
    } finally {
      fake.state.savedCardStatus = 'success';
      clockTime = null;
    }
  });

  test('pause, resume, skip and cancel', async () => {
    const customer = await register('customer');
    try {
      clockTime = '2026-10-15T08:00:00Z';
      const { body } = await call('POST', '/recurring', { token: customer.token, body: recurringBody({ frequency: 'monthly', firstVisitAt: '2026-10-31T07:00:00Z' }) });
      const id = body.recurring.id;
      assert.equal(body.recurring.nextVisitAt, '2026-11-30T07:00:00.000Z', '31st clamps to the end of November');
      assert.equal((await call('POST', `/recurring/${id}/skip`, { token: customer.token })).body.nextVisitAt, '2026-12-31T07:00:00.000Z', 'and back to the 31st');

      assert.equal((await call('PATCH', `/recurring/${id}`, { token: customer.token, body: { status: 'paused' } })).body.nextVisitAt, null);
      clockTime = '2027-02-10T08:00:00Z';
      await runScheduler();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE recurring_id = ?').get(id).n, 1, 'nothing booked while paused');
      const resumed = await call('PATCH', `/recurring/${id}`, { token: customer.token, body: { status: 'active' } });
      assert.equal(resumed.body.nextVisitAt, '2027-02-28T07:00:00.000Z', 'missed visits are skipped, not booked in the past');

      const other = await register('customer');
      assert.equal((await call('PATCH', `/recurring/${id}`, { token: other.token, body: { status: 'cancelled' } })).status, 403);
      await call('PATCH', `/recurring/${id}`, { token: customer.token, body: { status: 'cancelled' } });
      assert.deepEqual((await call('GET', '/recurring', { token: customer.token })).body, []);
    } finally {
      clockTime = null;
    }
  });

  test('repeat bookings are validated', async () => {
    const customer = await register('customer');
    assert.equal((await call('POST', '/recurring', { token: customer.token, body: recurringBody({ frequency: 'daily', firstVisitAt: '2030-01-01T08:00:00Z' }) })).status, 400);
    assert.equal((await call('POST', '/recurring', { token: customer.token, body: recurringBody({ firstVisitAt: new Date(Date.now() + 60000).toISOString() }) })).status, 400);
  });
});

describe('two-way ratings', () => {
  test('customer and pro rate each other once; each sees the right things', async () => {
    const customer = await register('customer');
    const pro = await onlinePro(['painting']);
    const id = await completedJob(customer, pro, { categoryId: 'painting' });

    const before = (await call('GET', `/jobs/${id}`, { token: pro.token })).body.reviews;
    assert.deepEqual(before, { mine: null, theirs: null, canReview: true });

    assert.equal((await call('POST', `/jobs/${id}/rate`, { token: pro.token, body: { rating: 0 } })).status, 400);
    const proRated = await call('POST', `/jobs/${id}/rate`, { token: pro.token, body: { rating: 4, comment: 'Friendly, clear brief' } });
    assert.equal(proRated.status, 200);
    assert.deepEqual(proRated.body.reviews.mine, { rating: 4, comment: 'Friendly, clear brief', createdAt: proRated.body.reviews.mine.createdAt });
    assert.equal((await call('POST', `/jobs/${id}/rate`, { token: pro.token, body: { rating: 5 } })).status, 409, 'once only');

    await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: 5, comment: 'Neat work' } });
    // The pro sees the customer's (public) review of them; the customer doesn't see the pro's review of them.
    assert.equal((await call('GET', `/jobs/${id}`, { token: pro.token })).body.reviews.theirs.comment, 'Neat work');
    const customerView = (await call('GET', `/jobs/${id}`, { token: customer.token })).body;
    assert.equal(customerView.reviews.theirs, null);
    assert.equal(customerView.customer.rating, undefined, "customers don't see their own rating on the job");

    // Pros see the customer's average on later jobs.
    const { id: next } = await book(customer, { categoryId: 'painting' });
    const offered = (await call('GET', '/provider/requests', { token: pro.token })).body.find((j) => j.id === next);
    assert.deepEqual([offered.customer.rating, offered.customer.ratingCount], [4, 1]);
    assert.equal((await call('GET', '/me', { token: customer.token })).body.rating, 4);

    // Outsiders can't rate.
    assert.equal((await call('POST', `/jobs/${id}/rate`, { token: (await register('customer')).token, body: { rating: 1 } })).status, 403);
  });

  test('ratings close after the review window and need a finished job', async () => {
    const { customer, id } = await jobInProgress();
    assert.equal((await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: 5 } })).status, 409);
    const pro = await onlinePro(['painting']);
    const done = await completedJob(customer, pro, { categoryId: 'painting' });
    try {
      clockTime = new Date(Date.now() + 15 * 86400000).toISOString();
      const late = await call('POST', `/jobs/${done}/rate`, { token: customer.token, body: { rating: 5 } });
      assert.equal(late.status, 409);
      assert.match(late.body.error, /14 days/);
      assert.equal((await call('GET', `/jobs/${done}`, { token: customer.token })).body.reviews.canReview, false);
    } finally {
      clockTime = null;
    }
  });

  test('a pro profile shows the average, completed jobs and recent reviews', async () => {
    const pro = await onlinePro(['gardening']);
    const ratings = [5, 4, 5];
    for (const [i, r] of ratings.entries()) {
      const customer = await register('customer', { name: `Thabo Mokoena${i}` });
      const id = await completedJob(customer, pro, { categoryId: 'gardening' });
      await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: r, comment: `Visit ${i}` } });
    }
    const viewer = await register('customer');
    const { body } = await call('GET', `/pros/${pro.user.id}`, { token: viewer.token });
    assert.equal(body.rating, 4.7);
    assert.equal(body.ratingCount, 3);
    assert.equal(body.completedJobs, 3);
    assert.deepEqual(body.breakdown, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 });
    assert.deepEqual(body.recentReviews.map((r) => r.comment), ['Visit 2', 'Visit 1', 'Visit 0']);
    assert.equal(body.recentReviews[0].reviewer, 'Thabo M.', 'first name and initial only');
    assert.equal(body.recentReviews[0].categoryName, 'Gardening');
    assert.equal(body.verified, true);
    assert.equal((await call('GET', `/pros/${viewer.user.id}`, { token: viewer.token })).status, 404, 'customers have no public profile');
    // The cached average used for matching agrees.
    assert.equal((await call('GET', '/me', { token: pro.token })).body.provider.rating, 4.7);
  });

  test('admins see users whose rating has dropped below 3.5 (after 3+ reviews)', async () => {
    const pro = await onlinePro(['pest-control']);
    const rude = await register('customer', { name: 'Rude Customer' });
    const flaggedIds = async () => (await admin('GET', '/flags')).body.users.map((u) => u.id);
    for (const [i, r] of [2, 3].entries()) {
      const customer = await register('customer');
      const id = await completedJob(customer, pro, { categoryId: 'pest-control' });
      await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: r, comment: `Bad ${i}` } });
    }
    assert.ok(!(await flaggedIds()).includes(pro.user.id), 'two reviews are not enough to flag anyone');
    const third = await register('customer');
    const id = await completedJob(third, pro, { categoryId: 'pest-control' });
    await call('POST', `/jobs/${id}/rate`, { token: third.token, body: { rating: 4 } });
    const flags = (await admin('GET', '/flags')).body;
    const entry = flags.users.find((u) => u.id === pro.user.id);
    assert.deepEqual([entry.role, entry.average, entry.count, entry.lowCount], ['provider', 3, 3, 1]);
    assert.equal(entry.recent[0].rating, 4);
    assert.equal(flags.threshold, 3.5);
    assert.ok((await admin('GET', '/overview')).body.lowRatedUsers >= 1);
    assert.equal((await admin('GET', `/providers/${pro.user.id}`)).body.ratingFlagged, true);

    // Customers can be flagged too, from pros' ratings.
    for (let i = 0; i < 3; i++) {
      const p = await onlinePro(['pest-control']);
      const jobId = await completedJob(rude, p, { categoryId: 'pest-control' });
      await call('POST', `/jobs/${jobId}/rate`, { token: p.token, body: { rating: 2, comment: 'Abusive on site' } });
    }
    assert.ok((await flaggedIds()).includes(rude.user.id));
    const detail = await admin('GET', `/jobs/${id}`);
    assert.equal(detail.body.provider.flagged, true);
    assert.equal(detail.body.customer.flagged, false);
    assert.deepEqual(detail.body.jobReviews.map((r) => [r.reviewerRole, r.rating]), [['customer', 4]]);
    assert.equal((await call('GET', '/admin/flags', { token: pro.token })).status, 403);
  });

  test('ratings from before two-way reviews are carried over', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pronow-reviews-'));
    const file = path.join(dir, 'old.db');
    try {
      const fresh = openDb(file);
      fresh.exec(`DELETE FROM settings WHERE key = 'migration:reviews'; DROP TABLE reviews;`);
      fresh.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('customer', 'C', 'c@x.com', 'x'), ('provider', 'P', 'p@x.com', 'x')").run();
      fresh.prepare('INSERT INTO provider_profiles (user_id, rating_sum, rating_count) VALUES (2, 99, 20)').run();
      fresh.prepare("INSERT INTO jobs (customer_id, provider_id, category_id, description, size, address, lat, lng, status, estimated_cents) VALUES (1, 2, 'plumbing', 'x', 'small', 'x', 0, 0, 'completed', 100)").run();
      fresh.prepare("INSERT INTO ratings (job_id, rating, comment) VALUES (1, 4, 'Good')").run();
      fresh.close();
      const db2 = openDb(file);
      assert.deepEqual({ ...db2.prepare('SELECT reviewer_id, reviewee_id, reviewer_role, rating, comment FROM reviews').get() },
        { reviewer_id: 1, reviewee_id: 2, reviewer_role: 'customer', rating: 4, comment: 'Good' });
      assert.deepEqual({ ...db2.prepare('SELECT rating_sum, rating_count FROM provider_profiles WHERE user_id = 2').get() }, { rating_sum: 4, rating_count: 1 });
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function publicGet(path) {
  const res = await fetch(`${base}/api${path}`);
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
}

describe('share my job', () => {
  test('family can follow the pro until the job ends, without seeing private details', async () => {
    const customer = await register('customer', { phone: '0821112222' });
    const pro = await onlinePro(['electrical']);
    await upload(pro.token, 'id', solidPng()); // a verification upload must never become the public photo
    const photo = await fetch(`${base}/api/provider/photo`, {
      method: 'PUT', headers: { authorization: `Bearer ${pro.token}`, 'content-type': 'image/png' }, body: solidPng(40, 40, [1, 2, 3]),
    });
    assert.equal(photo.status, 200);
    const vehicle = await call('PUT', '/provider/vehicle', { token: pro.token, body: { vehicle: { make: 'Toyota', model: 'Hilux', colour: 'White', plate: 'ca 123-456' } } });
    assert.deepEqual(vehicle.body.vehicle, { make: 'Toyota', model: 'Hilux', colour: 'White', plate: 'CA 123-456' });

    const { id } = await book(customer, { categoryId: 'electrical', address: '7 Secret Street' });
    assert.equal((await call('POST', `/jobs/${id}/share`, { token: pro.token })).status, 403, 'only the customer shares');
    const shared = await call('POST', `/jobs/${id}/share`, { token: customer.token });
    assert.equal(shared.status, 201);
    const token = shared.body.url.split('/track/')[1];
    assert.ok(token.length >= 32);
    assert.equal((await call('GET', `/jobs/${id}`, { token: customer.token })).body.shareLinks, 1);

    let view = await publicGet(`/share/${token}`);
    assert.equal(view.status, 200);
    assert.equal(view.cache, 'no-store');
    assert.equal(view.body.provider, null, 'no pro yet');
    assert.equal(view.body.customerFirstName, customer.user.name.split(' ')[0]);

    await call('POST', `/jobs/${id}/accept`, { token: pro.token });
    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'en_route' } });
    view = await publicGet(`/share/${token}`);
    assert.equal(view.body.provider.name, pro.user.name);
    assert.deepEqual(view.body.provider.vehicle, { make: 'Toyota', model: 'Hilux', colour: 'White', plate: 'CA 123-456' });
    assert.equal(view.body.provider.hasPhoto, true);
    assert.ok(view.body.providerLocation);
    assert.ok(view.body.etaMinutes >= 1);
    assert.deepEqual(view.body.emergencyNumbers.map((n) => n.number), ['10111', '112']);
    const raw = JSON.stringify(view.body);
    assert.ok(!raw.includes('Secret Street') && !raw.includes('0821112222') && !raw.includes(customer.user.email), 'no address, phone or email');

    // Live position follows the pro.
    const sock = await new Promise((resolve) => { const s = connect(base, { auth: { token: pro.token }, transports: ['websocket'] }); s.on('connect', () => resolve(s)); });
    sock.emit('location', { lat: -26.15, lng: 28.01 });
    await new Promise((r) => setTimeout(r, 150));
    sock.close();
    assert.deepEqual((await publicGet(`/share/${token}`)).body.providerLocation, { lat: -26.15, lng: 28.01 });

    const pic = await publicGet(`/share/${token}/photo`);
    assert.equal(pic.status, 200);
    assert.equal(pic.type, 'image/png');
    assert.equal(Buffer.from(pic.body).length, solidPng(40, 40, [1, 2, 3]).length, 'the profile photo, not the ID upload');

    // Once the job ends, the link only says so.
    for (const status of ['arrived', 'in_progress', 'completed']) await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status } });
    view = await publicGet(`/share/${token}`);
    assert.equal(view.body.ended, true);
    assert.equal(view.body.provider, undefined);
    assert.equal(view.body.providerLocation, undefined);
    assert.equal((await publicGet(`/share/${token}/photo`)).status, 404);
    assert.equal((await call('POST', `/jobs/${id}/share`, { token: customer.token })).status, 409, 'nothing to share after the job');
  });

  test('stopping sharing kills every link; bad tokens get nothing', async () => {
    const customer = await register('customer');
    const { id } = await book(customer);
    const a = (await call('POST', `/jobs/${id}/share`, { token: customer.token })).body.url.split('/track/')[1];
    const b = (await call('POST', `/jobs/${id}/share`, { token: customer.token })).body.url.split('/track/')[1];
    assert.equal((await publicGet(`/share/${a}`)).status, 200);
    assert.equal((await call('DELETE', `/jobs/${id}/share`, { token: customer.token })).body.activeLinks, 0);
    assert.equal((await publicGet(`/share/${a}`)).status, 404);
    assert.equal((await publicGet(`/share/${b}`)).status, 404);
    assert.equal((await publicGet('/share/not-a-real-token')).status, 404);
    assert.equal((await call('DELETE', `/jobs/${id}/share`, { token: (await register('customer')).token })).status, 403);
  });

  test('photo and vehicle are validated', async () => {
    const pro = await onlinePro();
    const bad = await fetch(`${base}/api/provider/photo`, { method: 'PUT', headers: { authorization: `Bearer ${pro.token}`, 'content-type': 'image/png' }, body: Buffer.from('%PDF-1.4 not a photo at all') });
    assert.equal(bad.status, 400);
    assert.equal((await call('PUT', '/provider/vehicle', { token: pro.token, body: { vehicle: { make: 'VW', plate: '!' } } })).status, 400);
    assert.equal((await call('PUT', '/provider/vehicle', { token: pro.token, body: { vehicle: { make: '', plate: 'ND 12345' } } })).status, 400);
    assert.equal((await call('PUT', '/provider/vehicle', { token: pro.token, body: { vehicle: null } })).body.vehicle, null);
  });
});

describe('emergency button', () => {
  test('customer or pro can raise an alert; admins are told with the job details', async () => {
    const { customer, pro, id } = await jobInProgress();
    const outsider = await register('customer');
    assert.equal((await call('POST', `/jobs/${id}/emergency`, { token: outsider.token })).status, 403);

    const raised = await call('POST', `/jobs/${id}/emergency`, { token: customer.token, body: {} });
    assert.equal(raised.status, 201);
    assert.equal(raised.body.status, 'open');
    assert.equal(raised.body.role, 'customer');
    // Pressing again doesn't create a second alert; location can follow.
    const again = await call('POST', `/jobs/${id}/emergency`, { token: customer.token, body: { lat: -26.2, lng: 28.04 } });
    assert.equal(again.body.id, raised.body.id);
    assert.deepEqual(again.body.location, { lat: -26.2, lng: 28.04 });
    assert.equal((await call('GET', `/jobs/${id}`, { token: customer.token })).body.myEmergency.id, raised.body.id);

    await notifier.idle();
    const adminNote = (await call('GET', '/notifications', { token: adminToken })).body.items.find((n) => n.type === 'emergency_alert' && n.jobId === id);
    assert.match(adminNote.title, new RegExp(`EMERGENCY on job #${id}`));
    assert.equal(adminNote.url, `/admin/jobs/${id}`);
    const list = (await admin('GET', '/emergencies?status=open')).body;
    const entry = list.find((a) => a.id === raised.body.id);
    assert.equal(entry.raisedBy.name, customer.user.name);
    assert.equal(entry.provider.name, pro.user.name);
    assert.ok(entry.customer.phone !== undefined && entry.job.address);
    assert.ok((await admin('GET', '/overview')).body.openEmergencies >= 1);

    // The pro can raise one too.
    assert.equal((await call('POST', `/jobs/${id}/emergency`, { token: pro.token, body: { note: 'Threatened on site' } })).body.role, 'provider');

    // Handling.
    assert.equal((await admin('POST', `/emergencies/${raised.body.id}`, { status: 'resolved' })).status, 400, 'note required');
    assert.equal((await admin('POST', `/emergencies/${raised.body.id}`, { status: 'acknowledged' })).body.status, 'acknowledged');
    const resolved = await admin('POST', `/emergencies/${raised.body.id}`, { status: 'resolved', note: 'Called customer, police attended' });
    assert.equal(resolved.body.status, 'resolved');
    assert.equal((await call('POST', `/emergencies/${raised.body.id}`, { token: customer.token })).status, 404);
  });

  test('cancelling a false alarm, and when the button is available', async () => {
    const { customer, pro, id } = await jobInProgress();
    const alert = (await call('POST', `/jobs/${id}/emergency`, { token: pro.token })).body;
    assert.equal((await call('PATCH', `/emergencies/${alert.id}`, { token: customer.token, body: { cancel: true } })).status, 403, 'only the person who raised it');
    assert.equal((await call('PATCH', `/emergencies/${alert.id}`, { token: pro.token, body: { cancel: true } })).body.status, 'false_alarm');

    const fresh = await register('customer');
    const { id: unassigned } = await book(fresh);
    assert.equal((await call('POST', `/jobs/${unassigned}/emergency`, { token: fresh.token })).status, 409, 'no pro yet');

    await call('POST', `/jobs/${id}/status`, { token: pro.token, body: { status: 'completed' } });
    assert.equal((await call('POST', `/jobs/${id}/emergency`, { token: customer.token })).status, 201, 'still available just after the job');
    try {
      clockTime = new Date(Date.now() + 2 * 3600000).toISOString();
      assert.equal((await call('POST', `/jobs/${id}/emergency`, { token: pro.token })).status, 409);
    } finally {
      clockTime = null;
    }
  });

  test('the on-call safety number gets an SMS', async () => {
    const { config } = await import('../src/config.js');
    const before = sentSms.length;
    config.safety.alertPhone = '082 999 0000';
    try {
      const { customer, id } = await jobInProgress();
      await call('POST', `/jobs/${id}/emergency`, { token: customer.token });
      await notifier.idle();
      const text = sentSms.slice(before).find((m) => m.to === '+27829990000');
      assert.match(text.body, new RegExp(`emergency button on job #${id}`));
    } finally {
      config.safety.alertPhone = '';
    }
  });
});

describe('whole-rand amounts', () => {
  test('parts entered with cents are rounded to whole rands', async () => {
    const customer = await register('customer');
    const pro = await onlinePro();
    const id = await completedJob(customer, pro, { materialsCents: 1250 });
    const job = (await call('GET', `/jobs/${id}`, { token: customer.token })).body;
    assert.equal(job.materialsCents, 1300);
    assert.equal(job.finalCents % 100, 0);
    assert.equal((await call('GET', `/jobs/${id}`, { token: pro.token })).body.payoutCents % 100, 0);
  });
});

describe('address search', () => {
  test('proxies search and reverse lookups for signed-in users', async () => {
    const { token } = await register('customer');
    const search = await call('GET', '/geocode/search?q=Long%20Street', { token });
    assert.deepEqual(search.body, [{ label: 'Result for Long Street', lat: -33.9249, lng: 18.4241 }]);
    const reverse = await call('GET', '/geocode/reverse?lat=-26.2&lng=28.04', { token });
    assert.equal(reverse.body.label, 'Somewhere');
  });

  test('ignores short queries and requires sign-in', async () => {
    const { token } = await register('customer');
    assert.deepEqual((await call('GET', '/geocode/search?q=ab', { token })).body, []);
    assert.equal((await call('GET', '/geocode/search?q=Long%20Street')).status, 401);
    assert.equal((await call('GET', '/geocode/reverse?lat=999&lng=0', { token })).status, 400);
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
      const body = { job: await book(customer, { categoryId: 'electrical' }) };
      assert.equal((await offer).id, body.job.id);

      const update = next(cs, 'job:updated');
      await call('POST', `/jobs/${body.job.id}/accept`, { token: pro.token });
      assert.equal((await update).status, 'accepted');

      const msg = next(ps, 'message:new');
      await call('POST', `/jobs/${body.job.id}/messages`, { token: customer.token, body: { body: 'Gate code 1234' } });
      assert.equal((await msg).body, 'Gate code 1234');

      const loc = next(cs, 'provider:location');
      ps.emit('location', { lat: -26.2, lng: 28.05 });
      assert.deepEqual(await loc, { jobId: body.job.id, lat: -26.2, lng: 28.05 });
    } finally {
      cs.close();
      ps.close();
    }
  });

  test('rejects sockets without a valid token', async () => {
    await assert.rejects(socketFor('bogus'));
  });
});
