import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { badRequest, conflict, notFound } from './errors.js';
import { isValidPoint } from './geo.js';
import { parseSchedule } from './jobs.js';
import { hoursToday, isWithinHours, validateSchedule } from './time.js';
import { sniffType } from './verification.js';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** A pro's work settings: which trades they offer, when they work, and where. */
export function createProviderService({ db, notify, notifyAdmins, notifier, uploadDir, now = () => new Date() }) {
  const photoDir = path.resolve(uploadDir, 'photos');
  mkdirSync(photoDir, { recursive: true });
  const profile = (userId) => db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(userId);
  const trades = (userId) => db.prepare('SELECT category_id AS id, status FROM provider_categories WHERE user_id = ? ORDER BY rowid').all(userId);

  function settingsFor(userId) {
    const p = profile(userId);
    if (!p) throw notFound('Pro not found');
    const schedule = parseSchedule(p.working_hours);
    return {
      trades: trades(userId),
      workingHours: schedule,
      serviceArea: p.service_lat != null ? { lat: p.service_lat, lng: p.service_lng, radiusKm: p.service_radius_km } : null,
      defaultRadiusKm: config.dispatchRadiusKm,
      maxRadiusKm: config.maxServiceRadiusKm,
      timezone: config.timezone,
      availability: { withinHours: isWithinHours(schedule, now(), config.timezone), hoursToday: hoursToday(schedule, now(), config.timezone) },
      hasPhoto: Boolean(p.photo_file),
      vehicle: p.vehicle_plate || p.vehicle_make
        ? { make: p.vehicle_make, model: p.vehicle_model, colour: p.vehicle_colour, plate: p.vehicle_plate }
        : null,
    };
  }

  /** Profile photo customers see (separate from the private ID-verification selfie). */
  async function setPhoto(userId, buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('Choose a photo');
    if (buffer.length > MAX_PHOTO_BYTES) throw badRequest('Photos must be 5 MB or smaller');
    const mime = sniffType(buffer);
    if (!PHOTO_TYPES[mime]) throw badRequest('Upload a JPG, PNG or WebP photo');
    const fileName = `${randomBytes(16).toString('hex')}${PHOTO_TYPES[mime]}`;
    await writeFile(path.join(photoDir, fileName), buffer, { flag: 'wx', mode: 0o600 });
    const old = profile(userId).photo_file;
    db.prepare('UPDATE provider_profiles SET photo_file = ? WHERE user_id = ?').run(fileName, userId);
    if (old) await unlink(path.join(photoDir, old)).catch(() => {});
    return settingsFor(userId);
  }

  function photoFile(userId) {
    const file = profile(userId)?.photo_file;
    if (!file) throw notFound('No photo');
    return path.join(photoDir, file);
  }

  /** Vehicle shown to the customer and on share links. null = no vehicle (e.g. walks or uses public transport). */
  function setVehicle(userId, input) {
    if (input === null) {
      db.prepare('UPDATE provider_profiles SET vehicle_make = NULL, vehicle_model = NULL, vehicle_colour = NULL, vehicle_plate = NULL WHERE user_id = ?').run(userId);
      return settingsFor(userId);
    }
    const plate = clean(input?.plate, 12).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 -]{1,11}$/.test(plate)) throw badRequest('Enter the registration number, e.g. CA 123-456 or ND 12345');
    const make = clean(input?.make, 30);
    if (!make) throw badRequest('Enter the make, e.g. Toyota');
    db.prepare('UPDATE provider_profiles SET vehicle_make = ?, vehicle_model = ?, vehicle_colour = ?, vehicle_plate = ? WHERE user_id = ?')
      .run(make, clean(input?.model, 30), clean(input?.colour, 20), plate, userId);
    return settingsFor(userId);
  }

  /**
   * Replaces the pro's trades. Trades they already had keep their status; new ones start pending. For a pro
   * who is already verified, an admin has to approve the new trade (their certificate may not cover it).
   */
  function setTrades(userId, ids) {
    const known = new Set(db.prepare('SELECT id FROM categories').all().map((c) => c.id));
    const wanted = [...new Set(Array.isArray(ids) ? ids : [])].filter((id) => known.has(id));
    if (!wanted.length) throw badRequest('Pick at least one trade');
    const current = new Map(trades(userId).map((t) => [t.id, t.status]));
    for (const id of current.keys()) {
      if (!wanted.includes(id)) db.prepare('DELETE FROM provider_categories WHERE user_id = ? AND category_id = ?').run(userId, id);
    }
    const added = wanted.filter((id) => !current.has(id));
    for (const id of added) {
      db.prepare("INSERT INTO provider_categories (user_id, category_id, status) VALUES (?, ?, 'pending')").run(userId, id);
    }
    if (added.length && profile(userId).verification_status === 'approved') notifyAdmins('admin:updated', { type: 'trades', userId });
    return settingsFor(userId);
  }

  function setHours(userId, input) {
    let schedule;
    try {
      schedule = validateSchedule(input ?? null);
    } catch (err) {
      throw badRequest(err.message);
    }
    if (schedule && !Object.values(schedule).some(Boolean)) throw badRequest('Choose at least one day you work, or pick "Any time"');
    db.prepare('UPDATE provider_profiles SET working_hours = ? WHERE user_id = ?').run(schedule ? JSON.stringify(schedule) : null, userId);
    return settingsFor(userId);
  }

  function setServiceArea(userId, input) {
    if (input === null) {
      db.prepare('UPDATE provider_profiles SET service_lat = NULL, service_lng = NULL, service_radius_km = NULL WHERE user_id = ?').run(userId);
      return settingsFor(userId);
    }
    const lat = Number(input?.lat);
    const lng = Number(input?.lng);
    const radiusKm = Number(input?.radiusKm);
    if (!isValidPoint(lat, lng)) throw badRequest('Tap the map to set the centre of your area');
    if (!(radiusKm >= 1 && radiusKm <= config.maxServiceRadiusKm)) {
      throw badRequest(`Radius must be between 1 and ${config.maxServiceRadiusKm} km`);
    }
    db.prepare('UPDATE provider_profiles SET service_lat = ?, service_lng = ?, service_radius_km = ? WHERE user_id = ?')
      .run(lat, lng, Math.round(radiusKm * 10) / 10, userId);
    return settingsFor(userId);
  }

  /** Admin decision on trades a verified pro added later. */
  function decideTrades(userId, decision) {
    const pending = trades(userId).filter((t) => t.status === 'pending');
    if (!pending.length) throw conflict('No trades are waiting for approval');
    if (decision === 'approve') {
      db.prepare("UPDATE provider_categories SET status = 'approved' WHERE user_id = ? AND status = 'pending'").run(userId);
    } else if (decision === 'reject') {
      db.prepare("DELETE FROM provider_categories WHERE user_id = ? AND status = 'pending'").run(userId);
    } else {
      throw badRequest('Decision must be approve or reject');
    }
    const names = pending.map((t) => db.prepare('SELECT name FROM categories WHERE id = ?').get(t.id).name);
    notifier.notify(userId, decision === 'approve' ? 'trades_approved' : 'trades_rejected', { names });
    notify(userId, 'verification:updated', {});
    notifyAdmins('admin:updated', { type: 'trades', userId });
  }

  return { settingsFor, setTrades, setHours, setServiceArea, decideTrades, setPhoto, photoFile, setVehicle };
}
