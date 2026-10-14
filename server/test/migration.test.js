import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

test('databases from before the admin role are migrated without losing data', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pronow-db-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK (role IN ('customer', 'provider')),
        name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE provider_profiles (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        bio TEXT NOT NULL DEFAULT '', is_online INTEGER NOT NULL DEFAULT 0, lat REAL, lng REAL,
        location_updated_at TEXT, rating_sum INTEGER NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users (role, name, email, password_hash) VALUES ('provider', 'Old Pro', 'old@pro.com', 'x');
      INSERT INTO provider_profiles (user_id, is_online) VALUES (1, 1);`);
    old.close();

    const db = openDb(file);
    assert.equal(db.prepare('SELECT name FROM users WHERE id = 1').get().name, 'Old Pro');
    const profile = db.prepare('SELECT * FROM provider_profiles WHERE user_id = 1').get();
    assert.equal(profile.verification_status, 'unsubmitted', 'existing pros must be verified before taking new jobs');
    db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Ops', 'ops@x.com', 'x')").run();
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // Foreign keys still point at the rebuilt table.
    assert.throws(() => db.prepare('INSERT INTO provider_profiles (user_id) VALUES (999)').run(), /FOREIGN KEY/);
    db.close();
    openDb(file).close(); // a second open is a no-op
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
