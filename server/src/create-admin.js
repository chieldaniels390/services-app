// Creates an admin account: npm run create-admin -- you@example.com "Your Name"
// Uses ADMIN_PASSWORD if set, otherwise prints a generated one. Admins can't sign up through the app.
import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';
import { config } from './config.js';
import { openDb } from './db.js';

const [email, ...nameParts] = process.argv.slice(2);
if (!/^\S+@\S+\.\S+$/.test(email ?? '')) {
  console.error('Usage: npm run create-admin -- you@example.com "Your Name"');
  process.exit(1);
}
const db = openDb(config.dbFile);
if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
  console.error(`An account with ${email} already exists. Use a separate email for admin access.`);
  process.exit(1);
}
const password = process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url');
if (password.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters');
  process.exit(1);
}
db.prepare("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', ?, ?, ?)")
  .run(nameParts.join(' ') || 'Admin', email, hashPassword(password));
console.log(`Admin created: ${email}`);
if (!process.env.ADMIN_PASSWORD) console.log(`Password: ${password}  (shown once - store it somewhere safe)`);
