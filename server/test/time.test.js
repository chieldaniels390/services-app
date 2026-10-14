import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursToday, isWithinHours, periodStarts, validateSchedule } from '../src/time.js';

const TZ = 'Africa/Johannesburg'; // UTC+2, no daylight saving
const at = (iso) => new Date(iso);
const weekdays = validateSchedule({
  mon: { start: '08:00', end: '17:00' }, tue: { start: '08:00', end: '17:00' }, wed: { start: '08:00', end: '17:00' },
  thu: { start: '08:00', end: '17:00' }, fri: { start: '08:00', end: '13:00' },
});

test('working hours are checked in local time', () => {
  // Monday 12 October 2026.
  assert.equal(isWithinHours(weekdays, at('2026-10-12T06:00:00Z'), TZ), true, '08:00 local, opening time');
  assert.equal(isWithinHours(weekdays, at('2026-10-12T05:59:00Z'), TZ), false, '07:59 local');
  assert.equal(isWithinHours(weekdays, at('2026-10-12T15:00:00Z'), TZ), false, '17:00 local, closing time');
  assert.equal(isWithinHours(weekdays, at('2026-10-16T11:30:00Z'), TZ), false, 'Friday 13:30 local, after a half day');
  assert.equal(isWithinHours(weekdays, at('2026-10-17T08:00:00Z'), TZ), false, 'Saturday off');
  assert.equal(isWithinHours(null, at('2026-10-17T08:00:00Z'), TZ), true, 'no schedule means any time');
  assert.equal(hoursToday(weekdays, at('2026-10-17T08:00:00Z'), TZ), 'Off today');
  assert.equal(hoursToday(weekdays, at('2026-10-12T08:00:00Z'), TZ), '08:00-17:00');
});

test('overnight shifts run past midnight', () => {
  const nights = validateSchedule({ sat: { start: '22:00', end: '06:00' }, sun: { start: '18:00', end: '24:00' } });
  assert.equal(isWithinHours(nights, at('2026-10-17T21:00:00Z'), TZ), true, 'Saturday 23:00');
  assert.equal(isWithinHours(nights, at('2026-10-18T03:30:00Z'), TZ), true, 'Sunday 05:30, still Saturday night');
  assert.equal(isWithinHours(nights, at('2026-10-18T04:00:00Z'), TZ), false, 'Sunday 06:00, shift over');
  assert.equal(isWithinHours(nights, at('2026-10-18T21:59:00Z'), TZ), true, 'Sunday 23:59 (until midnight)');
  assert.equal(isWithinHours(nights, at('2026-10-18T22:00:00Z'), TZ), false, 'Monday 00:00');
});

test('schedules are validated', () => {
  assert.throws(() => validateSchedule({ mon: { start: '8am', end: '17:00' } }), /08:00/);
  assert.throws(() => validateSchedule({ mon: { start: '09:00', end: '09:00' } }), /mon/);
  assert.throws(() => validateSchedule({ mon: { start: '25:00', end: '26:00' } }));
  assert.throws(() => validateSchedule([1, 2]));
  assert.equal(validateSchedule(null), null);
});

test('today, this week and this month start at local midnight', () => {
  // Thursday 15 October 2026, 01:30 in Johannesburg (still the 14th in UTC).
  const starts = periodStarts(at('2026-10-14T23:30:00Z'), TZ);
  assert.equal(starts.today.toISOString(), '2026-10-14T22:00:00.000Z');
  assert.equal(starts.week.toISOString(), '2026-10-11T22:00:00.000Z', 'Monday 12 October');
  assert.equal(starts.month.toISOString(), '2026-09-30T22:00:00.000Z', '1 October');
});
