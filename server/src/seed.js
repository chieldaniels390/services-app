// Creates demo accounts so the app is explorable straight away. Safe to re-run.
import { hashPassword } from './auth.js';
import { config } from './config.js';
import { openDb, transaction } from './db.js';

const PASSWORD = 'password123';
const PROS = [
  { name: 'Mario Rossi', email: 'plumber@demo.com', categories: ['plumbing', 'hvac'], bio: '15 years fixing leaks and boilers.' },
  { name: 'Ada Volt', email: 'electrician@demo.com', categories: ['electrical', 'appliances'], bio: 'Certified electrician, same-day call-outs.' },
  { name: 'Sam Sparkle', email: 'cleaner@demo.com', categories: ['cleaning'], bio: 'Deep cleans and end-of-tenancy specialist.' },
  { name: 'Lee Keys', email: 'locksmith@demo.com', categories: ['locksmith', 'handyman'], bio: 'Locked out? I am usually there in 20 min.' },
  { name: 'Jo Fixit', email: 'handyman@demo.com', categories: ['handyman', 'painting', 'gardening'], bio: 'No job too small.' },
];

const db = openDb(config.dbFile);
const { lat, lng } = config.defaultCenter;
const exists = db.prepare('SELECT id FROM users WHERE email = ?');
const insertUser = db.prepare('INSERT INTO users (role, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)');

transaction(db, () => {
  if (!exists.get('customer@demo.com')) {
    insertUser.run('customer', 'Casey Customer', 'customer@demo.com', '+1 555 0100', hashPassword(PASSWORD));
  }
  PROS.forEach((pro, i) => {
    if (exists.get(pro.email)) return;
    const { lastInsertRowid } = insertUser.run('provider', pro.name, pro.email, `+1 555 01${10 + i}`, hashPassword(PASSWORD));
    const id = Number(lastInsertRowid);
    // Scatter pros a few km around the default city centre, already online.
    const angle = (i / PROS.length) * 2 * Math.PI;
    db.prepare(`INSERT INTO provider_profiles (user_id, bio, is_online, lat, lng, rating_sum, rating_count)
      VALUES (?, ?, 1, ?, ?, ?, ?)`)
      .run(id, pro.bio, lat + 0.03 * Math.sin(angle), lng + 0.045 * Math.cos(angle), 4 * 20 + 18 + i, 20);
    for (const c of pro.categories) db.prepare('INSERT INTO provider_categories VALUES (?, ?)').run(id, c);
  });
});

console.log(`Seeded demo accounts (password: ${PASSWORD}):`);
console.log('  customer@demo.com');
for (const p of PROS) console.log(`  ${p.email}  (${p.categories.join(', ')})`);
