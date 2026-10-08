import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, settle, surgeMultiplier } from '../src/pricing.js';

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
