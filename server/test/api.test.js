import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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

before(async () => {
  const geocoder = {
    search: async (q) => [{ label: `Result for ${q}`, lat: -33.9249, lng: 18.4241 }],
    reverse: async (lat, lng) => ({ label: 'Somewhere', lat, lng }),
  };
  fake = await startFakePaystack({ secretKey: SECRET });
  const paystack = createPaystack({ secretKey: SECRET, baseUrl: fake.url });
  db = openDb(':memory:');
  uploadDir = mkdtempSync(path.join(tmpdir(), 'pronow-uploads-'));
  ({ server } = createApp({ db, geocoder, paystack, uploadDir }));
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
const approveDirectly = (pro) => db.prepare("UPDATE provider_profiles SET verification_status = 'approved' WHERE user_id = ?").run(pro.user.id);

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
    assert.equal(rated.body.review.rating, 5);
    assert.equal((await call('POST', `/jobs/${id}/rate`, { token: customer.token, body: { rating: 4 } })).status, 409);

    const me = await call('GET', '/me', { token: pro.token });
    assert.equal(me.body.provider.rating, 5);
    const earnings = await call('GET', '/provider/earnings', { token: pro.token });
    assert.equal(earnings.body.allTime.cents, done.body.payoutCents);
    assert.equal(earnings.body.pendingPayoutCents, done.body.payoutCents - 1000, 'labour payout waits for bank details; parts are not paid yet');
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
