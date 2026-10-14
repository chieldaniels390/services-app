import { DatabaseSync } from 'node:sqlite';
import { CATEGORIES } from './categories.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('customer', 'provider', 'admin')),
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

-- Refunds issued against a payment (full or partial). created_by is NULL for automatic refunds.
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  paystack_id TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS refunds_job ON refunds (job_id);

-- Verification documents. Files live on disk under UPLOAD_DIR, never in the public web root.
CREATE TABLE IF NOT EXISTS provider_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('id', 'certificate', 'selfie')),
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS provider_documents_user ON provider_documents (user_id, kind);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  opened_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_note TEXT,
  refund_cents INTEGER NOT NULL DEFAULT 0,
  payout_action TEXT,
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS disputes_job ON disputes (job_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '/',
  job_id INTEGER REFERENCES jobs(id),
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every SMS attempt, so delivery problems and costs can be checked.
CREATE TABLE IF NOT EXISTS sms_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id),
  type TEXT NOT NULL,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sms_messages_job ON sms_messages (job_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  // unsubmitted -> pending -> approved | rejected. Only approved pros can go online or take jobs.
  ['provider_profiles', 'verification_status', "TEXT NOT NULL DEFAULT 'unsubmitted'"],
  ['provider_profiles', 'verification_note', 'TEXT'],
  ['provider_profiles', 'verification_submitted_at', 'TEXT'],
  ['provider_profiles', 'verified_at', 'TEXT'],
  ['provider_profiles', 'verified_by', 'INTEGER'],
  ['payments', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'sms_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  // Where and when a pro works. NULLs mean "around my live location, any time".
  ['provider_profiles', 'service_lat', 'REAL'],
  ['provider_profiles', 'service_lng', 'REAL'],
  ['provider_profiles', 'service_radius_km', 'REAL'],
  ['provider_profiles', 'working_hours', 'TEXT'],
  // approved | pending. Trades added after verification are pending until an admin approves them.
  // Existing rows default to approved: they were part of the pro's original verification.
  ['provider_categories', 'status', "TEXT NOT NULL DEFAULT 'approved'"],
];

/**
 * Databases created before the admin role existed have a CHECK constraint that rejects it.
 * SQLite can't alter a CHECK, so rebuild the table (the documented 12-step procedure, condensed).
 */
function allowAdminRole(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (sql.includes("'admin'")) return;
  const columns = 'id, role, name, email, phone, password_hash, created_at';
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK (role IN ('customer', 'provider', 'admin')),
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          phone TEXT,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users_new (${columns}) SELECT ${columns} FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;`);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Foreign key check failed after migrating users: ${JSON.stringify(broken)}`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrate(db) {
  allowAdminRole(db);
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
