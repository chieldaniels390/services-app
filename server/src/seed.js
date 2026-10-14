// Creates demo accounts so the app is explorable straight away. Safe to re-run.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';
import { config } from './config.js';
import { openDb, transaction } from './db.js';
import { solidPng } from './png.js';

const PASSWORD = 'password123';
const PROS = [
  { name: 'Sipho Dlamini', email: 'plumber@demo.com', categories: ['plumbing', 'hvac'], bio: '15 years fixing leaks, geysers and burst pipes.' },
  { name: 'Thandi Nkosi', email: 'electrician@demo.com', categories: ['electrical', 'appliances'], bio: 'Registered electrician, COCs and same-day call-outs.' },
  { name: 'Lerato Mokoena', email: 'cleaner@demo.com', categories: ['cleaning'], bio: 'Deep cleans and move-out specialist.' },
  { name: 'Pieter van Wyk', email: 'locksmith@demo.com', categories: ['locksmith', 'handyman'], bio: 'Locked out? I am usually there in 20 min.' },
  { name: 'Ayesha Patel', email: 'handyman@demo.com', categories: ['handyman', 'painting', 'gardening'], bio: 'No job too small.' },
  // Waiting in the admin review queue, so the verification flow can be tried straight away.
  { name: 'Bongani Zulu', email: 'newpro@demo.com', categories: ['plumbing', 'handyman'], bio: 'Qualified plumber, new to ProNow.', status: 'pending' },
];
const DOC_COLOURS = { id: [70, 110, 190], certificate: [60, 150, 90], selfie: [210, 150, 90] };

const docsDir = path.resolve(config.uploadDir, 'documents');
mkdirSync(docsDir, { recursive: true });
function addDemoDocuments(userId) {
  for (const [kind, colour] of Object.entries(DOC_COLOURS)) {
    const png = solidPng(240, 160, colour);
    const fileName = `${randomBytes(16).toString('hex')}.png`;
    writeFileSync(path.join(docsDir, fileName), png, { mode: 0o600 });
    db.prepare("INSERT INTO provider_documents (user_id, kind, file_name, mime, size_bytes) VALUES (?, ?, ?, 'image/png', ?)")
      .run(userId, kind, fileName, png.length);
  }
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo accounts (with a known admin password) in production.');
  process.exit(1);
}

const db = openDb(config.dbFile);
const { lat, lng } = config.defaultCenter;
const exists = db.prepare('SELECT id FROM users WHERE email = ?');
const insertUser = db.prepare('INSERT INTO users (role, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)');

transaction(db, () => {
  if (!exists.get('admin@demo.com')) {
    insertUser.run('admin', 'Demo Admin', 'admin@demo.com', null, hashPassword(PASSWORD));
  }
  if (!exists.get('customer@demo.com')) {
    insertUser.run('customer', 'Naledi Customer', 'customer@demo.com', '+27 82 555 0100', hashPassword(PASSWORD));
  }
  PROS.forEach((pro, i) => {
    if (exists.get(pro.email)) return;
    const { lastInsertRowid } = insertUser.run('provider', pro.name, pro.email, `+27 82 555 01${10 + i}`, hashPassword(PASSWORD));
    const id = Number(lastInsertRowid);
    // Scatter pros a few km around the default city centre. Approved ones start online.
    const angle = (i / PROS.length) * 2 * Math.PI;
    const status = pro.status ?? 'approved';
    db.prepare(`INSERT INTO provider_profiles (user_id, bio, is_online, lat, lng, rating_sum, rating_count,
        verification_status, verification_submitted_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`)
      .run(id, pro.bio, status === 'approved' ? 1 : 0, lat + 0.03 * Math.sin(angle), lng + 0.045 * Math.cos(angle),
        status === 'approved' ? 4 * 20 + 18 + i : 0, status === 'approved' ? 20 : 0, status,
        status === 'approved' ? new Date().toISOString() : null);
    addDemoDocuments(id);
    for (const c of pro.categories) db.prepare('INSERT INTO provider_categories VALUES (?, ?)').run(id, c);
  });
});

console.log(`Seeded demo accounts (password: ${PASSWORD}):`);
console.log('  admin@demo.com     (admin panel)');
console.log('  customer@demo.com');
for (const p of PROS) console.log(`  ${p.email}  (${p.categories.join(', ')})${p.status === 'pending' ? '  - awaiting verification' : ''}`);
console.log('Demo accounts are for local testing only. Create real admins with: npm run create-admin -- you@example.com "Your Name"');
