import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { distanceKm, etaMinutes, isValidPoint } from './geo.js';
import { ratingOf } from './jobs.js';

const ACTIVE = ['accepted', 'en_route', 'arrived', 'in_progress'];
const ENDED = ['completed', 'cancelled'];
const hash = (token) => createHash('sha256').update(String(token)).digest('hex');
const fromSql = (v) => new Date(`${v.replace(' ', 'T')}Z`);

/**
 * "Share my job" links for family, and the emergency button.
 * Share links are bearer links: anyone with the URL can follow the job until it ends, so they show only
 * what family needs (pro, vehicle, live position, status) - never phone numbers or the street address.
 */
export function createSafetyService({ db, jobs, notifier, notifyAdmins, now = () => new Date() }) {
  const job = (id) => {
    const row = jobs.getJobRow(id);
    if (!row) throw notFound('Job not found');
    return row;
  };

  const vehicleOf = (p) => (p?.vehicle_plate || p?.vehicle_make
    ? { make: p.vehicle_make, model: p.vehicle_model, colour: p.vehicle_colour, plate: p.vehicle_plate }
    : null);

  // --- Share my job ----------------------------------------------------------

  function createShare(customer, jobId) {
    const row = job(jobId);
    if (row.customer_id !== customer.id) throw forbidden();
    if (ENDED.includes(row.status) || row.status === 'awaiting_payment') throw conflict('You can share a job while it is in progress');
    const token = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO job_shares (job_id, token_hash, created_by) VALUES (?, ?, ?)').run(jobId, hash(token), customer.id);
    return { url: `${config.appUrl}/track/${token}`, activeLinks: activeShares(jobId) };
  }

  const activeShares = (jobId) => db.prepare('SELECT COUNT(*) AS n FROM job_shares WHERE job_id = ? AND revoked_at IS NULL').get(jobId).n;

  /** Stop sharing: every link for the job stops working. */
  function revokeShares(customer, jobId) {
    const row = job(jobId);
    if (row.customer_id !== customer.id) throw forbidden();
    db.prepare("UPDATE job_shares SET revoked_at = datetime('now') WHERE job_id = ? AND revoked_at IS NULL").run(jobId);
    return { activeLinks: 0 };
  }

  function shareRow(token) {
    const share = db.prepare('SELECT * FROM job_shares WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token));
    if (!share) throw notFound('This link is no longer active');
    return job(share.job_id);
  }

  /** What the public tracking page shows. After the job ends, only that it has ended. */
  function viewShare(token) {
    const row = shareRow(token);
    const base = {
      status: row.status,
      category: { name: row.category_name, icon: row.category_icon },
      customerFirstName: row.customer_name.split(' ')[0],
      emergencyNumbers: config.safety.emergencyNumbers,
    };
    if (ENDED.includes(row.status)) {
      return { ...base, ended: true, endedAt: row.completed_at ?? row.cancelled_at };
    }
    const profile = row.provider_id && db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(row.provider_id);
    const live = profile && ACTIVE.includes(row.status) && profile.lat != null ? { lat: profile.lat, lng: profile.lng } : null;
    return {
      ...base,
      ended: false,
      scheduledFor: row.scheduled_for,
      destination: { lat: row.lat, lng: row.lng },
      provider: row.provider_id
        ? {
            name: row.provider_name,
            hasPhoto: Boolean(profile.photo_file),
            vehicle: vehicleOf(profile),
            verified: profile.verification_status === 'approved',
            rating: ratingOf(profile.rating_sum, profile.rating_count),
            ratingCount: profile.rating_count,
          }
        : null,
      providerLocation: live,
      etaMinutes: live && row.status === 'en_route' ? etaMinutes(distanceKm(live, row)) : null,
      times: { requested: row.created_at, accepted: row.accepted_at, started: row.started_at },
      updatedAt: now().toISOString(),
    };
  }

  /** The pro's photo for a live share link (not after the job ends). */
  function sharePhotoOwner(token) {
    const row = shareRow(token);
    if (ENDED.includes(row.status) || !row.provider_id) throw notFound('No photo');
    return row.provider_id;
  }

  // --- Emergency button --------------------------------------------------------

  function canRaise(row) {
    if (ACTIVE.includes(row.status)) return true;
    return row.status === 'completed' && row.completed_at
      && now().getTime() - fromSql(row.completed_at).getTime() < config.safety.afterJobMinutes * 60000;
  }

  const alertDto = (a) => ({
    id: a.id, jobId: a.job_id, role: a.role, status: a.status, note: a.note,
    location: a.lat != null ? { lat: a.lat, lng: a.lng } : null,
    createdAt: a.created_at, updatedAt: a.updated_at, handledNote: a.handled_note,
  });
  const getAlert = (id) => db.prepare('SELECT * FROM emergency_alerts WHERE id = ?').get(id);

  /**
   * Raises an alert straight away (no confirmation step: speed matters) and tells every admin.
   * Pressing again while an alert is open updates it rather than creating another.
   */
  function raise(user, jobId, input = {}) {
    const row = job(jobId);
    const role = user.id === row.customer_id ? 'customer' : user.id === row.provider_id ? 'provider' : null;
    if (!role) throw forbidden();
    if (!canRaise(row)) throw conflict('The emergency button is available while a job is under way. If you are in danger, call 10111 or 112 now.');
    const point = isValidPoint(Number(input.lat), Number(input.lng)) ? { lat: Number(input.lat), lng: Number(input.lng) } : null;
    const note = String(input.note ?? '').trim().slice(0, 500);

    const open = db.prepare("SELECT * FROM emergency_alerts WHERE job_id = ? AND raised_by = ? AND status = 'open'").get(jobId, user.id);
    if (open) {
      if (point || note) updateAlert(user, open.id, { ...point, note: note || undefined });
      return alertDto(getAlert(open.id));
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO emergency_alerts (job_id, raised_by, role, lat, lng, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, user.id, role, point?.lat ?? null, point?.lng ?? null, note);
    const alert = getAlert(Number(lastInsertRowid));

    const ctx = { job: row, raisedBy: role === 'customer' ? row.customer_name : row.provider_name, role, alertId: alert.id };
    for (const { id } of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) notifier.notify(id, 'emergency_alert', ctx);
    notifier.smsTo(config.safety.alertPhone, `ProNow EMERGENCY: ${ctx.raisedBy} (${role === 'customer' ? 'customer' : 'pro'}) pressed the emergency button on job #${row.id}. ${config.appUrl}/admin/jobs/${row.id}`);
    notifyAdmins('admin:emergency', { alertId: alert.id, jobId: row.id });
    notifyAdmins('admin:updated', { type: 'emergency', jobId: row.id });
    return alertDto(alert);
  }

  /** The person who raised it can add their location or a note, or cancel it as a false alarm. */
  function updateAlert(user, alertId, input = {}) {
    const alert = getAlert(alertId);
    if (!alert) throw notFound('Alert not found');
    if (alert.raised_by !== user.id) throw forbidden();
    if (input.cancel) {
      if (alert.status !== 'open') throw conflict('This alert is already being handled');
      db.prepare("UPDATE emergency_alerts SET status = 'false_alarm', handled_note = 'Cancelled by the person who raised it', updated_at = datetime('now') WHERE id = ?").run(alertId);
    } else {
      const point = isValidPoint(Number(input.lat), Number(input.lng)) ? { lat: Number(input.lat), lng: Number(input.lng) } : null;
      if (point) db.prepare("UPDATE emergency_alerts SET lat = ?, lng = ?, updated_at = datetime('now') WHERE id = ?").run(point.lat, point.lng, alertId);
      if (input.note) db.prepare("UPDATE emergency_alerts SET note = ?, updated_at = datetime('now') WHERE id = ?").run(String(input.note).slice(0, 500), alertId);
    }
    notifyAdmins('admin:updated', { type: 'emergency', jobId: alert.job_id });
    return alertDto(getAlert(alertId));
  }

  /** The viewer's own open alert on a job, so the sheet can show "alert sent". */
  const openAlertFor = (user, jobId) => {
    const a = db.prepare("SELECT * FROM emergency_alerts WHERE job_id = ? AND raised_by = ? AND status IN ('open', 'acknowledged') ORDER BY id DESC").get(jobId, user.id);
    return a ? alertDto(a) : null;
  };

  // --- Admin -------------------------------------------------------------------

  function listAlerts({ status } = {}) {
    const where = status === 'open' ? "WHERE a.status IN ('open', 'acknowledged')" : '';
    return db.prepare(`
      SELECT a.*, u.name AS raised_by_name, u.phone AS raised_by_phone, c.name AS category_name, c.icon AS category_icon,
        j.address, j.status AS job_status, cu.name AS customer_name, cu.phone AS customer_phone,
        pu.name AS provider_name, pu.phone AS provider_phone, h.name AS handled_by_name
      FROM emergency_alerts a JOIN users u ON u.id = a.raised_by JOIN jobs j ON j.id = a.job_id
      JOIN categories c ON c.id = j.category_id JOIN users cu ON cu.id = j.customer_id
      LEFT JOIN users pu ON pu.id = j.provider_id LEFT JOIN users h ON h.id = a.handled_by
      ${where} ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, a.id DESC LIMIT 200`).all()
      .map((a) => ({
        ...alertDto(a),
        raisedBy: { name: a.raised_by_name, phone: a.raised_by_phone },
        job: { status: a.job_status, address: a.address, category: { name: a.category_name, icon: a.category_icon } },
        customer: { name: a.customer_name, phone: a.customer_phone },
        provider: a.provider_name ? { name: a.provider_name, phone: a.provider_phone } : null,
        handledBy: a.handled_by_name,
      }));
  }

  const alertsForJob = (jobId) => listAlerts().filter((a) => a.jobId === jobId);

  function handleAlert(admin, alertId, { status, note }) {
    const alert = getAlert(alertId);
    if (!alert) throw notFound('Alert not found');
    if (!['acknowledged', 'resolved', 'false_alarm'].includes(status)) throw badRequest('Unknown status');
    if (status !== 'acknowledged' && !String(note ?? '').trim()) throw badRequest('Add a note on what happened');
    db.prepare("UPDATE emergency_alerts SET status = ?, handled_by = ?, handled_note = COALESCE(?, handled_note), updated_at = datetime('now') WHERE id = ?")
      .run(status, admin.id, note ? String(note).trim().slice(0, 1000) : null, alertId);
    notifyAdmins('admin:updated', { type: 'emergency', jobId: alert.job_id });
    return alertDto(getAlert(alertId));
  }

  const openAlertCount = () => db.prepare("SELECT COUNT(*) AS n FROM emergency_alerts WHERE status = 'open'").get().n;

  return {
    createShare, revokeShares, activeShares, viewShare, sharePhotoOwner,
    raise, updateAlert, openAlertFor, listAlerts, alertsForJob, handleAlert, openAlertCount, vehicleOf,
  };
}
