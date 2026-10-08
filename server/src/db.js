import { DatabaseSync } from 'node:sqlite';
import { CATEGORIES } from './categories.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('customer', 'provider')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  description TEXT NOT NULL,
  callout_cents INTEGER NOT NULL,
  hourly_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio TEXT NOT NULL DEFAULT '',
  is_online INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  location_updated_at TEXT,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provider_categories (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  PRIMARY KEY (user_id, category_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  provider_id INTEGER REFERENCES users(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  description TEXT NOT NULL,
  size TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  scheduled_for TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  surge REAL NOT NULL DEFAULT 1,
  estimated_cents INTEGER NOT NULL,
  materials_cents INTEGER NOT NULL DEFAULT 0,
  final_cents INTEGER,
  platform_fee_cents INTEGER,
  payout_cents INTEGER,
  cancelled_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_category ON jobs (status, category_id);
CREATE INDEX IF NOT EXISTS jobs_customer ON jobs (customer_id);
CREATE INDEX IF NOT EXISTS jobs_provider ON jobs (provider_id);

CREATE TABLE IF NOT EXISTS ratings (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_job ON messages (job_id);

-- One row per payment attempt (each Paystack checkout or saved-card charge).
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'materials')),
  reference TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  authorization_url TEXT,
  authorization_code TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS payments_job ON payments (job_id);

-- Money owed to a pro, sent as Paystack transfers.
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  provider_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('labour', 'materials')),
  amount_cents INTEGER NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'awaiting_details',
  transfer_code TEXT,
  failure_reason TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS payouts_provider ON payouts (provider_id);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS won't add them to an existing database.
const ADDED_COLUMNS = [
  ['jobs', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'"],
  ['jobs', 'materials_status', 'TEXT'],
  ['jobs', 'fee_rate', 'REAL'],
  ['provider_profiles', 'payout_recipient_code', 'TEXT'],
  ['provider_profiles', 'payout_bank_name', 'TEXT'],
  ['provider_profiles', 'payout_account_last4', 'TEXT'],
  ['provider_profiles', 'payout_account_name', 'TEXT'],
];

function migrate(db) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  const upsert = db.prepare(`
    INSERT INTO categories (id, name, icon, description, callout_cents, hourly_cents)
    VALUES ($id, $name, $icon, $description, $callout, $hourly)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, icon = excluded.icon,
      description = excluded.description, callout_cents = excluded.callout_cents,
      hourly_cents = excluded.hourly_cents`);
  for (const c of CATEGORIES) upsert.run(c);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
