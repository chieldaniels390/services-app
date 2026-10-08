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
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
