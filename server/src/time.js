// Time-zone aware helpers. Dates are stored in UTC; working hours and "today/this week" are local time.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const formatters = new Map();
function partsIn(date, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    weekday: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)), hour: Number(p.hour), minute: Number(p.minute),
  };
}

/** The UTC instant of a wall-clock time in a time zone (handles any fixed or DST offset). */
export function zonedTime(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - shown;
  }
  return new Date(guess);
}

/** Starts of today, this week (Monday) and this month, local time. */
export function periodStarts(now, timeZone) {
  const p = partsIn(now, timeZone);
  const today = zonedTime(p.year, p.month, p.day, 0, 0, timeZone);
  const sinceMonday = (p.weekday + 6) % 7;
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - sinceMonday));
  return {
    today,
    week: zonedTime(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0, timeZone),
    month: zonedTime(p.year, p.month, 1, 0, 0, timeZone),
  };
}

/** Local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(date, timeZone) {
  const p = partsIn(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** SQLite's datetime('now') format, for comparing with stored timestamps. */
export const toSqlTime = (date) => date.toISOString().replace('T', ' ').slice(0, 19);

// --- Working hours -----------------------------------------------------
// A schedule is { mon: { start: '08:00', end: '17:00' }, tue: null, ... } (null = day off),
// or null meaning "any time". An end at or before the start runs past midnight (e.g. 22:00-06:00).

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export function validateSchedule(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Working hours must be a weekly schedule');
  const schedule = {};
  for (const day of WEEKDAYS) {
    const slot = input[day];
    if (!slot) {
      schedule[day] = null;
      continue;
    }
    if (!TIME.test(slot.start ?? '') || !TIME.test(slot.end ?? '')) throw new Error(`Times for ${day} must look like 08:00`);
    if (slot.start === slot.end || slot.start === '24:00') throw new Error(`Check the hours for ${day}`);
    schedule[day] = { start: slot.start, end: slot.end };
  }
  return schedule;
}

/** Is this moment inside the schedule? Overnight shifts count towards the day they start on. */
export function isWithinHours(schedule, date, timeZone) {
  if (!schedule) return true;
  const p = partsIn(date, timeZone);
  const now = p.hour * 60 + p.minute;
  const today = schedule[DAYS[p.weekday]];
  if (today) {
    const start = minutes(today.start);
    const end = minutes(today.end);
    if (end > start ? now >= start && now < end : now >= start) return true;
  }
  const yesterday = schedule[DAYS[(p.weekday + 6) % 7]];
  if (yesterday && minutes(yesterday.end) <= minutes(yesterday.start) && now < minutes(yesterday.end)) return true;
  return false;
}

/** Today's hours as text, e.g. "08:00-17:00", "Off today" or "Any time". */
export function hoursToday(schedule, date, timeZone) {
  if (!schedule) return 'Any time';
  const slot = schedule[DAYS[partsIn(date, timeZone).weekday]];
  return slot ? `${slot.start}-${slot.end}` : 'Off today';
}
