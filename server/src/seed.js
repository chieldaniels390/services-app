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
// Vehicles customers (and family following a shared job) see.
const VEHICLES = {
  'plumber@demo.com': ['Toyota', 'Hilux', 'White', 'GP 482-917'],
  'electrician@demo.com': ['Nissan', 'NP200', 'Silver', 'CA 219-334'],
  'cleaner@demo.com': ['Suzuki', 'Swift', 'Red', 'GP 77 KLM'],
  'locksmith@demo.com': ['Ford', 'Ranger', 'Blue', 'ND 55102'],
  'handyman@demo.com': ['Volkswagen', 'Caddy', 'White', 'GP 310-221'],
};
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
    const home = { lat: lat + 0.03 * Math.sin(angle), lng: lng + 0.045 * Math.cos(angle) };
    // Demo pros work any time (so the demo works at night too) within 25 km of where they start.
    db.prepare(`INSERT INTO provider_profiles (user_id, bio, is_online, lat, lng, rating_sum, rating_count,
        verification_status, verification_submitted_at, verified_at, service_lat, service_lng, service_radius_km)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 25)`)
      .run(id, pro.bio, status === 'approved' ? 1 : 0, home.lat, home.lng,
        0, 0, status, // ratings come from the demo reviews below
        status === 'approved' ? new Date().toISOString() : null, home.lat, home.lng);
    addDemoDocuments(id);
    if (VEHICLES[pro.email]) {
      db.prepare('UPDATE provider_profiles SET vehicle_make = ?, vehicle_model = ?, vehicle_colour = ?, vehicle_plate = ? WHERE user_id = ?')
        .run(...VEHICLES[pro.email], id);
    }
    for (const c of pro.categories) {
      db.prepare('INSERT INTO provider_categories (user_id, category_id, status) VALUES (?, ?, ?)')
        .run(id, c, status === 'approved' ? 'approved' : 'pending');
    }
  });
});

// A few weeks of paid, completed jobs for the demo plumber, so the earnings dashboard has something to show.
const plumber = exists.get('plumber@demo.com');
const customer = exists.get('customer@demo.com');
const hasHistory = db.prepare("SELECT 1 FROM jobs WHERE provider_id = ? AND status = 'completed'").get(plumber.id);
if (!hasHistory) {
  const { callout_cents: callout, hourly_cents: hourly } = db.prepare("SELECT * FROM categories WHERE id = 'plumbing'").get();
  const history = [
    [1, 1, 0], [2, 2, 18000], [3, 1, 0], [5, 4, 42000], [6, 1, 0], [8, 2, 0], [9, 1, 9500], [12, 2, 0],
    [13, 1, 0], [15, 4, 0], [17, 2, 26000], [19, 1, 0], [22, 2, 0], [24, 1, 12000], [26, 4, 0], [29, 2, 0], [33, 1, 0],
  ]; // [days ago, hours, parts cents]
  transaction(db, () => {
    // Oldest first, so job numbers go up over time like real bookings.
    for (const [daysAgo, hours, parts] of [...history].reverse()) {
      const estimated = callout + hourly * hours;
      const fee = Math.round(estimated * config.platformFeeRate);
      const done = new Date(Date.now() - daysAgo * 86400000 - (2 + (daysAgo % 5)) * 3600000).toISOString().replace('T', ' ').slice(0, 19);
      const size = { 1: 'small', 2: 'medium', 4: 'large' }[hours];
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO jobs (customer_id, provider_id, category_id, description, size, address, lat, lng, status, estimated_cents,
          materials_cents, final_cents, platform_fee_cents, payout_cents, payment_status, materials_status, fee_rate,
          created_at, accepted_at, started_at, completed_at)
        VALUES (?, ?, 'plumbing', 'Demo job', ?, 'Demo address, Johannesburg', ?, ?, 'completed', ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?)`)
        .run(customer.id, plumber.id, size, lat, lng, estimated, parts, estimated + parts, fee, estimated - fee + parts,
          parts ? 'paid' : null, config.platformFeeRate, done, done, done, done);
      const jobId = Number(lastInsertRowid);
      const payment = db.prepare(`INSERT INTO payments (job_id, kind, reference, amount_cents, status, paid_at, created_at)
        VALUES (?, ?, ?, ?, 'paid', ?, ?)`);
      payment.run(jobId, 'booking', `bk_demo_${jobId}`, estimated, done, done);
      if (parts) payment.run(jobId, 'materials', `mt_demo_${jobId}`, parts, done, done);
      const payout = db.prepare(`INSERT INTO payouts (job_id, provider_id, kind, amount_cents, reference, status, paid_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      // The most recent payout is still on its way, the rest have landed.
      const status = daysAgo <= 1 ? 'processing' : 'paid';
      payout.run(jobId, plumber.id, 'labour', estimated - fee, `po_demo_${jobId}_l`, status, status === 'paid' ? done : null, done);
      if (parts) payout.run(jobId, plumber.id, 'materials', parts, `po_demo_${jobId}_m`, status, status === 'paid' ? done : null, done);
    }
  });
}

// --- Demo reviews -----------------------------------------------------------
// Real review rows (both directions), so pro profiles, customer ratings and the admin's low-rating flags have data.
const CUSTOMER_COMMENTS = [
  [5, 'Arrived on time, explained everything and left the place spotless.'],
  [5, 'Fixed it in no time. Will definitely book again.'],
  [4, 'Good work, a little later than the ETA but kept me updated.'],
  [5, 'Very professional and friendly.'],
  [5, ''],
  [4, 'Solid job, fair price.'],
  [5, 'Went the extra mile and checked the other taps too.'],
];
const PRO_COMMENTS = [[5, 'Clear instructions and easy access.'], [5, ''], [4, 'Friendly, paid for parts quickly.']];
if (!db.prepare('SELECT 1 FROM reviews LIMIT 1').get()) {
  const naledi = exists.get('customer@demo.com');
  const addReview = db.prepare(`INSERT OR IGNORE INTO reviews (job_id, reviewer_id, reviewee_id, reviewer_role, rating, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // A few past jobs for each demo pro (the plumber already has his earnings history).
  const pastJob = (customerId, proId, categoryId, daysAgo) => {
    const done = new Date(Date.now() - daysAgo * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO jobs (customer_id, provider_id, category_id, description, size, address, lat, lng, status, estimated_cents,
        final_cents, platform_fee_cents, payout_cents, payment_status, fee_rate, created_at, accepted_at, completed_at)
      VALUES (?, ?, ?, 'Demo job', 'small', 'Demo address, Johannesburg', ?, ?, 'completed', 50000, 50000, 7500, 42500, 'paid', 0.15, ?, ?, ?)`)
      .run(customerId, proId, categoryId, lat, lng, done, done, done);
    return { id: Number(lastInsertRowid), done };
  };
  transaction(db, () => {
    for (const pro of PROS.filter((p) => !p.status && p.email !== 'plumber@demo.com')) {
      const proId = exists.get(pro.email).id;
      for (let k = 0; k < 4; k++) {
        const job = pastJob(naledi.id, proId, pro.categories[k % pro.categories.length], 40 + k * 9);
        const [rating, comment] = CUSTOMER_COMMENTS[(k + pro.email.length) % CUSTOMER_COMMENTS.length];
        addReview.run(job.id, naledi.id, proId, 'customer', rating, comment, job.done);
      }
    }
    // The plumber's history: most customers left a review, and he rated them back.
    const history = db.prepare("SELECT id, completed_at FROM jobs WHERE provider_id = ? AND status = 'completed' ORDER BY id").all(plumber.id);
    history.forEach((job, k) => {
      if (k % 4 === 3) return;
      const [rating, comment] = CUSTOMER_COMMENTS[k % CUSTOMER_COMMENTS.length];
      addReview.run(job.id, customer.id, plumber.id, 'customer', rating, comment, job.completed_at);
      const [proRating, proComment] = PRO_COMMENTS[k % PRO_COMMENTS.length];
      addReview.run(job.id, plumber.id, customer.id, 'provider', proRating, proComment, job.completed_at);
    });
    // A customer pros have had trouble with, so the admin "Low ratings" list has someone on it.
    if (!exists.get('difficult@demo.com')) {
      insertUser.run('customer', 'Pat Difficult', 'difficult@demo.com', '+27 82 555 0199', hashPassword(PASSWORD));
    }
    const pat = exists.get('difficult@demo.com');
    [['electrician@demo.com', 'electrical', 2, 'Refused to pay for parts that were agreed on site.'],
      ['handyman@demo.com', 'handyman', 3, 'Kept changing the job once I arrived.'],
      ['locksmith@demo.com', 'locksmith', 2, 'Rude and aggressive.']].forEach(([email, cat, rating, comment], k) => {
      const proId = exists.get(email).id;
      const job = pastJob(pat.id, proId, cat, 5 + k * 6);
      addReview.run(job.id, proId, pat.id, 'provider', rating, comment, job.done);
    });
  });
  // Pros' cached averages, from the reviews.
  db.exec(`UPDATE provider_profiles SET
    rating_sum = (SELECT COALESCE(SUM(rating), 0) FROM reviews WHERE reviewee_id = provider_profiles.user_id),
    rating_count = (SELECT COUNT(*) FROM reviews WHERE reviewee_id = provider_profiles.user_id)`);
}

console.log(`Seeded demo accounts (password: ${PASSWORD}):`);
console.log('  admin@demo.com     (admin panel)');
console.log('  customer@demo.com');
console.log('  difficult@demo.com (a customer with low ratings from pros)');
for (const p of PROS) console.log(`  ${p.email}  (${p.categories.join(', ')})${p.status === 'pending' ? '  - awaiting verification' : ''}`);
console.log('Demo accounts are for local testing only. Create real admins with: npm run create-admin -- you@example.com "Your Name"');
