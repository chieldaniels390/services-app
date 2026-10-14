import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const DOCUMENT_KINDS = {
  id: { label: 'ID document', types: [...IMAGE_TYPES, 'application/pdf'] },
  certificate: { label: 'Trade certificate or licence', types: [...IMAGE_TYPES, 'application/pdf'] },
  selfie: { label: 'Selfie', types: IMAGE_TYPES },
};
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

/** Identify a file by its first bytes rather than trusting the browser's Content-Type. */
export function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Pros upload an ID, a trade certificate/licence and a selfie, then submit them for review.
 * Status: unsubmitted -> pending -> approved | rejected. Rejected pros can re-upload and resubmit.
 */
export function createVerificationService({ db, uploadDir, notify, notifyAdmins, notifier = { notify: () => {} } }) {
  const dir = path.resolve(uploadDir, 'documents');
  mkdirSync(dir, { recursive: true });

  const profile = (userId) => db.prepare('SELECT * FROM provider_profiles WHERE user_id = ?').get(userId);

  function documentsFor(userId) {
    return db.prepare(`
      SELECT id, kind, mime, size_bytes AS sizeBytes, created_at AS createdAt
      FROM provider_documents WHERE user_id = ? ORDER BY id`).all(userId);
  }

  function statusFor(userId) {
    const p = profile(userId);
    const docs = documentsFor(userId);
    return {
      status: p.verification_status,
      note: p.verification_note,
      submittedAt: p.verification_submitted_at,
      verifiedAt: p.verified_at,
      documents: docs,
      missing: Object.keys(DOCUMENT_KINDS).filter((k) => !docs.some((d) => d.kind === k)),
    };
  }

  async function upload(userId, kind, buffer) {
    const spec = DOCUMENT_KINDS[kind];
    if (!spec) throw badRequest('Unknown document type');
    const { verification_status: status } = profile(userId);
    if (status === 'pending') throw conflict('Your documents are being reviewed - you can change them if they are rejected');
    if (status === 'approved') throw conflict('You are already verified. Contact support to update your documents');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('Choose a file to upload');
    if (buffer.length > MAX_DOCUMENT_BYTES) throw badRequest('Files must be 8 MB or smaller');
    const mime = sniffType(buffer);
    if (!mime || !spec.types.includes(mime)) {
      throw badRequest(kind === 'selfie' ? 'Upload a JPG, PNG or WebP photo' : 'Upload a JPG, PNG, WebP or PDF file');
    }

    const fileName = `${randomBytes(16).toString('hex')}${EXTENSIONS[mime]}`;
    await writeFile(path.join(dir, fileName), buffer, { flag: 'wx', mode: 0o600 });
    // Keep only the latest copy of each document: no reason to hold old ID scans.
    const old = db.prepare('SELECT id, file_name FROM provider_documents WHERE user_id = ? AND kind = ?').all(userId, kind);
    db.prepare('INSERT INTO provider_documents (user_id, kind, file_name, mime, size_bytes) VALUES (?, ?, ?, ?, ?)')
      .run(userId, kind, fileName, mime, buffer.length);
    for (const doc of old) {
      db.prepare('DELETE FROM provider_documents WHERE id = ?').run(doc.id);
      await unlink(path.join(dir, doc.file_name)).catch(() => {});
    }
    return statusFor(userId);
  }

  function submit(userId) {
    const current = statusFor(userId);
    if (current.status === 'pending' || current.status === 'approved') throw conflict('Already submitted');
    if (current.missing.length) {
      throw badRequest(`Still needed: ${current.missing.map((k) => DOCUMENT_KINDS[k].label.toLowerCase()).join(', ')}`);
    }
    db.prepare(`
      UPDATE provider_profiles SET verification_status = 'pending', verification_note = NULL,
        verification_submitted_at = datetime('now') WHERE user_id = ?`).run(userId);
    notifyAdmins('admin:updated', { type: 'verification', userId });
    return statusFor(userId);
  }

  /** Admin decision. Rejecting an approved pro suspends them: they go offline and stop receiving jobs. */
  function decide(adminId, userId, { decision, note }) {
    const p = profile(userId);
    if (!p) throw notFound('Pro not found');
    if (decision === 'approve') {
      if (statusFor(userId).missing.length) throw conflict('This pro has not uploaded all their documents');
      db.prepare(`
        UPDATE provider_profiles SET verification_status = 'approved', verification_note = ?, verified_at = datetime('now'), verified_by = ?
        WHERE user_id = ?`).run(note?.trim() || null, adminId, userId);
      // Approving the pro approves the trades they applied with.
      db.prepare("UPDATE provider_categories SET status = 'approved' WHERE user_id = ?").run(userId);
    } else if (decision === 'reject') {
      if (!note?.trim()) throw badRequest('Tell the pro why, so they can fix it');
      db.prepare(`
        UPDATE provider_profiles SET verification_status = 'rejected', verification_note = ?, verified_at = NULL, verified_by = ?,
          is_online = 0
        WHERE user_id = ?`).run(note.trim().slice(0, 500), adminId, userId);
    } else {
      throw badRequest('Decision must be approve or reject');
    }
    notify(userId, 'verification:updated', statusFor(userId));
    notifier.notify(userId, decision === 'approve' ? 'verification_approved' : 'verification_rejected', { note: note?.trim() });
    notifyAdmins('admin:updated', { type: 'verification', userId });
    return statusFor(userId);
  }

  /** The file behind a document, for its owner or an admin only. */
  function documentFile(viewer, docId) {
    const doc = db.prepare('SELECT * FROM provider_documents WHERE id = ?').get(docId);
    if (!doc) throw notFound('Document not found');
    if (viewer.role !== 'admin' && viewer.id !== doc.user_id) throw forbidden();
    return { path: path.join(dir, doc.file_name), mime: doc.mime, kind: doc.kind };
  }

  const isApproved = (userId) => profile(userId)?.verification_status === 'approved';

  return { statusFor, upload, submit, decide, documentFile, isApproved };
}
