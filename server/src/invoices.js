import PDFDocument from 'pdfkit';
import { config } from './config.js';
import { transaction } from './db.js';
import { conflict, forbidden, notFound } from './errors.js';
import { rand } from './notifications.js';
import { JOB_SIZES } from './pricing.js';

const fromSql = (v) => new Date(`${v.replace(' ', 'T')}Z`);
const longDate = (v) => new Intl.DateTimeFormat('en-ZA', { timeZone: config.timezone, day: 'numeric', month: 'long', year: 'numeric' }).format(fromSql(v));

/**
 * Customer invoices. An invoice is issued (numbered and frozen) the first time it's requested, once the job is
 * complete and paid for. Re-downloads render the same snapshot, so later changes - VAT switched on, business
 * details edited, a later refund - never alter an invoice that was already issued.
 */
export function createInvoiceService({ db, platform }) {
  function issue(jobId) {
    const existing = db.prepare('SELECT * FROM invoices WHERE job_id = ?').get(jobId);
    if (existing) return { number: existing.number, ...JSON.parse(existing.data) };

    const job = db.prepare(`
      SELECT j.*, c.name AS category_name, cu.name AS customer_name, cu.email AS customer_email, pu.name AS provider_name
      FROM jobs j JOIN categories c ON c.id = j.category_id JOIN users cu ON cu.id = j.customer_id
      LEFT JOIN users pu ON pu.id = j.provider_id WHERE j.id = ?`).get(jobId);
    if (!job) throw notFound('Job not found');
    if (job.status !== 'completed') throw conflict('Invoices are available once the job is complete');
    if (job.payment_status === 'unpaid') throw conflict('This job was not paid through ProNow, so there is no invoice');
    if (job.materials_status === 'unpaid') throw conflict('Approve and pay for the parts first, then your invoice will be ready');

    const settings = platform.get();
    const lines = [{
      description: `${job.category_name} - ${JOB_SIZES[job.size]?.label ?? job.size}: call-out and labour (upfront price)${job.surge > 1 ? `, busy-time rate x${job.surge}` : ''}`,
      amountCents: job.estimated_cents,
    }];
    if (job.materials_cents > 0 && job.materials_status === 'paid') {
      lines.push({ description: 'Parts and materials (at cost)', amountCents: job.materials_cents });
    }
    const refunds = db.prepare('SELECT amount_cents AS amountCents, reason, created_at AS createdAt FROM refunds WHERE job_id = ? ORDER BY id').all(jobId);
    const payments = db.prepare(`
      SELECT kind, reference, amount_cents AS amountCents, paid_at AS paidAt FROM payments
      WHERE job_id = ? AND paid_at IS NOT NULL AND status IN ('paid', 'refund_pending', 'refunded') ORDER BY id`).all(jobId);
    const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const refundedCents = refunds.reduce((s, r) => s + r.amountCents, 0);
    const paidCents = totalCents - refundedCents;
    if (paidCents <= 0) throw conflict('This job was fully refunded, so there is nothing to invoice');

    const data = {
      issuedAt: new Date().toISOString(),
      currency: config.currency,
      business: {
        name: settings.businessName, address: settings.businessAddress, registrationNumber: settings.registrationNumber,
        footer: settings.invoiceFooter,
      },
      // Prices already include VAT (as South African consumer prices must), so VAT is shown as included.
      vat: settings.vatEnabled
        ? { enabled: true, rate: settings.vatRate, number: settings.vatNumber, includedCents: Math.round((paidCents * settings.vatRate) / (100 + settings.vatRate)) }
        : { enabled: false },
      customer: { name: job.customer_name, email: job.customer_email },
      serviceAddress: job.address,
      serviceDate: longDate(job.completed_at),
      jobId: job.id,
      jobDescription: job.description,
      providerName: job.provider_name,
      lines,
      refunds: refunds.map((r) => ({ ...r, date: longDate(r.createdAt) })),
      payments: payments.map((p) => ({ ...p, date: p.paidAt ? longDate(p.paidAt) : '' })),
      totalCents,
      refundedCents,
      paidCents,
    };

    try {
      return transaction(db, () => {
        const { lastInsertRowid } = db.prepare('INSERT INTO invoices (job_id, number, data) VALUES (?, ?, ?)')
          .run(jobId, `pending-${jobId}`, JSON.stringify(data));
        // Sequential, never reused: INV-2026-00042.
        const number = `INV-${data.issuedAt.slice(0, 4)}-${String(lastInsertRowid).padStart(5, '0')}`;
        db.prepare('UPDATE invoices SET number = ? WHERE id = ?').run(number, Number(lastInsertRowid));
        return { number, ...data };
      });
    } catch (err) {
      // Two downloads at once: the other one issued it.
      const raced = db.prepare('SELECT * FROM invoices WHERE job_id = ?').get(jobId);
      if (raced) return { number: raced.number, ...JSON.parse(raced.data) };
      throw err;
    }
  }

  /** The invoice for the job's customer (or an admin). */
  function forViewer(viewer, jobId) {
    const job = db.prepare('SELECT customer_id FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw notFound('Job not found');
    if (viewer.role !== 'admin' && viewer.id !== job.customer_id) throw forbidden();
    return issue(jobId);
  }

  return { issue, forViewer, render };
}

/** Renders an invoice snapshot as an A4 PDF. */
export function render(inv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${inv.vat.enabled ? 'Tax invoice' : 'Invoice'} ${inv.number}`, Author: inv.business.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ink = '#0f172a';
    const muted = '#64748b';
    const brand = '#0f766e';
    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;

    // Header: supplier on the left, document title on the right.
    doc.fillColor(brand).font('Helvetica-Bold').fontSize(20).text(inv.business.name, left, 50, { width: width / 2 });
    doc.fillColor(muted).font('Helvetica').fontSize(9);
    if (inv.business.address) doc.text(inv.business.address, { width: width / 2 });
    if (inv.business.registrationNumber) doc.text(`Company reg. ${inv.business.registrationNumber}`);
    if (inv.vat.enabled) doc.text(`VAT no. ${inv.vat.number}`);
    const headerBottom = doc.y;

    doc.fillColor(ink).font('Helvetica-Bold').fontSize(18).text(inv.vat.enabled ? 'TAX INVOICE' : 'INVOICE', left, 50, { width, align: 'right' });
    // Invoice details as a small two-column block: labels on the left, values right-aligned.
    const meta = [
      ['Invoice number', inv.number],
      ['Invoice date', new Intl.DateTimeFormat('en-ZA', { timeZone: config.timezone, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(inv.issuedAt))],
      ['Service date', inv.serviceDate],
      ['Job reference', `#${inv.jobId}`],
    ];
    let metaY = doc.y + 6;
    doc.fontSize(9);
    for (const [label, value] of meta) {
      doc.font('Helvetica').fillColor(muted).text(label, right - 210, metaY, { width: 90 });
      doc.font('Helvetica-Bold').fillColor(ink).text(value, right - 120, metaY, { width: 120, align: 'right' });
      metaY += 14;
    }
    doc.y = metaY;

    // Parties.
    let y = Math.max(headerBottom, doc.y) + 24;
    const col = width / 2;
    doc.fillColor(muted).fontSize(8).font('Helvetica-Bold').text('BILL TO', left, y).text('SERVICE', left + col, y);
    y += 12;
    doc.fillColor(ink).font('Helvetica').fontSize(10);
    doc.text(inv.customer.name, left, y, { width: col - 10 }).fillColor(muted).fontSize(9).text(inv.customer.email, { width: col - 10 });
    const leftBottom = doc.y;
    doc.fillColor(ink).fontSize(10).text(inv.serviceAddress, left + col, y, { width: col })
      .fillColor(muted).fontSize(9).text(inv.providerName ? `Carried out by ${inv.providerName}` : '', { width: col });
    y = Math.max(leftBottom, doc.y) + 24;

    // Line items.
    const amountX = right - 110;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#e2e8f0').lineWidth(1).stroke();
    y += 8;
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(8).text('DESCRIPTION', left, y).text('AMOUNT', amountX, y, { width: 110, align: 'right' });
    y += 16;
    doc.font('Helvetica').fontSize(10);
    for (const line of inv.lines) {
      doc.fillColor(ink).text(line.description, left, y, { width: amountX - left - 20 });
      const lineBottom = doc.y;
      doc.text(rand(line.amountCents), amountX, y, { width: 110, align: 'right' });
      y = lineBottom + 8;
    }
    if (inv.jobDescription) {
      doc.fillColor(muted).fontSize(9).text(`Job notes: ${inv.jobDescription}`, left, y, { width: amountX - left - 20 });
      y = doc.y + 8;
    }
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#e2e8f0').stroke();
    y += 10;

    // Totals.
    const total = (label, cents, { bold = false, color = ink } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor(color)
        .text(label, amountX - 200, y, { width: 190, align: 'right' })
        .text(cents, amountX, y, { width: 110, align: 'right' });
      y += bold ? 18 : 15;
    };
    total('Total', rand(inv.totalCents));
    for (const r of inv.refunds) total(`Refunded ${r.date}`, `-${rand(r.amountCents)}`, { color: muted });
    total(inv.refunds.length ? 'Total paid' : 'Amount paid', rand(inv.paidCents), { bold: true });
    if (inv.vat.enabled) total(`Includes VAT at ${inv.vat.rate}%`, rand(inv.vat.includedCents), { color: muted });

    // Payment details and footer.
    y += 16;
    if (inv.payments.length) doc.fillColor(muted).font('Helvetica-Bold').fontSize(8).text('PAYMENT', left, y);
    doc.fillColor(muted).font('Helvetica').fontSize(9);
    for (const p of inv.payments) {
      doc.text(`${p.kind === 'booking' ? 'Booking' : 'Parts'}: ${rand(p.amountCents)} paid by card on ${p.date} (ref ${p.reference})`, left, doc.y + 2, { width });
    }
    if (inv.business.footer) doc.moveDown(2).fillColor(muted).fontSize(9).text(inv.business.footer, left, doc.y, { width, align: 'center' });
    doc.end();
  });
}
