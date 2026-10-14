import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, settle, surgeMultiplier } from '../src/pricing.js';
import { rand, randExact } from '../src/notifications.js';

test('no surge while supply covers demand', () => {
  assert.equal(surgeMultiplier(3, 3), 1);
  assert.equal(surgeMultiplier(5, 0), 1);
});

test('surge grows with demand and is capped', () => {
  assert.equal(surgeMultiplier(4, 2), 1.3);
  assert.equal(surgeMultiplier(100, 1), 2);
});

test('quote = callout + hourly * hours, times surge', () => {
  const q = quote({ callout_cents: 5000, hourly_cents: 8000 }, 'medium', 1.5);
  assert.equal(q.totalCents, Math.round((5000 + 16000) * 1.5));
});

test('platform fee excludes materials', () => {
  assert.deepEqual(settle(10000, 2500, 0.15), { finalCents: 12500, platformFeeCents: 1500, payoutCents: 11000 });
});

test('prices, fees and payouts are whole rands', () => {
  // R1 015 at a 1.1x busy-time rate is R1 116.50, charged as R1 117.
  assert.equal(quote({ callout_cents: 46500, hourly_cents: 55000 }, 'small', 1.1).totalCents, 111700);
  // 15% of R1 550 is R232.50: the fee is R233 and the pro gets R1 317.
  assert.deepEqual(settle(155000, 0, 0.15), { finalCents: 155000, platformFeeCents: 23300, payoutCents: 131700 });
});

test('South African price format', () => {
  assert.equal(rand(100000), 'R1 000');
  assert.equal(rand(45000), 'R450');
  assert.equal(rand(131750), 'R1 318');
  assert.equal(rand(123456700), 'R1 234 567');
  // Exact amounts (VAT on a tax invoice) keep their cents.
  assert.equal(randExact(13043), 'R130.43');
  assert.equal(randExact(100000), 'R1 000');
  assert.equal(randExact(-20000), '-R200');
});
