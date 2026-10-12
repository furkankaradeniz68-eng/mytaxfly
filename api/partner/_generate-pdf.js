import { readFileSync } from 'fs';
import path from 'path';

/**
 * Shared PDF generation for both preview-filing and submit-filing.
 * @param {object} opts
 * @param {'5472_1120'|'1065'} opts.form_type
 * @param {object}   opts.company
 * @param {object}   [opts.foreign_owner]
 * @param {object[]} [opts.transactions]
 * @param {object[]} [opts.partners]
 * @param {object}   [opts.financials]
 * @param {number}   opts.tax_year
 * @param {boolean}  [opts.preview=false]  — adds "UNSIGNED PREVIEW" watermark when true
 * @returns {Promise<Uint8Array>}
 */
export async function generatePdf({
  form_type, company, foreign_owner, transactions = [],
  partners = [], financials = {}, tax_year, preview = false,
}) {
  if (form_type === '5472_1120') {
    return generate5472Bundle(company, foreign_owner, transactions, tax_year, preview);
  }
  return generate1065(company, partners, financials, tax_year, preview);
}

// ─── Form 5472 + Pro Forma 1120 bundle ──────────────────────────────────────

async function generate5472Bundle(company, owner, transactions, taxYear, preview) {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');

  const formsDir = path.join(process.cwd(), 'forms');
  const f5472Bytes = readFileSync(path.join(formsDir, 'f5472.pdf'));

  const doc5472 = await PDFDocument.load(f5472Bytes, { ignoreEncryption: true });
  const pages = doc5472.getPages();
  const p1 = pages[0]; // Part I & II
  const p2 = pages[1]; // Part III, IV, V, VI

  const font = await doc5472.embedFont(StandardFonts.Helvetica);
  const bold = await doc5472.embedFont(StandardFonts.HelveticaBold);

  const t = (pg, text, x, y, size = 10, f = font) =>
    pg.drawText(String(text ?? ''), { x, y, size, font: f, color: rgb(0, 0, 0) });

  const addr = company.address;

  // ── Page 1 — Part I ───────────────────────────────────────────────────────
  t(p1, `01/01`, 333, 697, 9);
  t(p1, `${taxYear}`, 364, 697, 9);
  t(p1, `12/31`, 460, 697, 9);
  t(p1, `${taxYear}`, 492, 697, 9);

  t(p1, company.name, 13, 655, 10, bold);
  t(p1, company.ein, 449, 655, 10);
  t(p1, addr.street || '', 13, 625, 10);
  t(p1, company.total_assets != null ? String(company.total_assets) : '0', 565, 625, 9);
  t(p1, `${addr.city}, ${addr.state} ${addr.zip || ''}`.trim(), 13, 604, 10);
  if (company.business_activity) t(p1, company.business_activity, 13, 590, 9);
  if (company.activity_code)     t(p1, company.activity_code,     430, 590, 9);
  t(p1, company.country_of_incorporation || 'US', 487, 527, 9);
  if (company.date_of_incorporation) t(p1, company.date_of_incorporation, 13, 507, 9);
  t(p1, 'United States', 163, 507, 9);
  t(p1, 'United States', 395, 507, 9);
  t(p1, 'X', 604, 437, 10, bold); // Row 3: foreign-owned U.S. DE

  // ── Page 1 — Part II ──────────────────────────────────────────────────────
  const ownerLine = [owner.name, owner.address].filter(Boolean).join(', ');
  t(p1, ownerLine, 13, 388, 9);
  t(p1, owner.us_tin || 'N/A', 13,  375, 9);
  t(p1, owner.ref_id || '',    163, 375, 9);
  t(p1, owner.ftin   || '',    328, 375, 9);
  const country = owner.country || '';
  t(p1, country, 13,  335, 9);
  t(p1, country, 180, 335, 9);
  t(p1, country, 330, 335, 9);

  // ── Page 2 — Part III ─────────────────────────────────────────────────────
  // Calibrated: y=720→8a label, y=706→8a input, y=668→8b inputs, y=649→8e checkbox
  t(p2, ownerLine, 13, 706, 9);
  t(p2, owner.us_tin || 'N/A', 13,  668, 9);
  t(p2, owner.ref_id || '',    163, 668, 9);
  t(p2, owner.ftin   || '',    328, 668, 9);
  // 8e: "25% foreign shareholder" checkbox (3rd option; text at x=486, PDF_y=649)
  t(p2, 'X', 477, 649, 9, bold);
  t(p2, country, 13,  621, 9); // 8f
  t(p2, country, 330, 621, 9); // 8g

  // ── Page 2 — Part IV ──────────────────────────────────────────────────────
  // Exact baselines from fitz.search_for() on blank form; 12.0pt spacing verified
  const LINE_Y = {
    9: 565, 10: 553, 11: 541, 12: 529, '13a': 517, '13b': 505,
    14: 493, 15: 481, 16: 469, 17: 457, 18: 445, 19: 433,
    20: 421, 21: 409, 22: 397,
    23: 385, 24: 373, 25: 361, 26: 349, '27a': 337, '27b': 325,
    28: 313, 29: 301, 30: 289, 31: 277, 32: 265, 33: 253,
    34: 241, 35: 229, 36: 217,
  };
  const LINE_X = 555;
  const TX_LINE_MAP = {
    loan_from_owner:    '31',
    loan_to_owner:      '17',
    services_paid:      '29',
    services_received:  '15',
    rent_paid:          '27a',
    rent_received:      '13a',
    royalties_paid:     '27b',
    royalties_received: '13b',
  };
  const fmtAmt = n => n != null ? String(Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })) : '';

  let hasPartV = false;
  for (const tx of transactions) {
    if (['capital_contribution', 'distribution'].includes(tx.type)) { hasPartV = true; continue; }
    const key = TX_LINE_MAP[tx.type];
    if (key && LINE_Y[key] != null && tx.amount) {
      t(p2, fmtAmt(tx.amount), LINE_X, LINE_Y[key], 9);
    }
  }
  // Part V "check here □" at x=485, PDF_y=171 (exact from blank-form fitz search)
  if (hasPartV) t(p2, 'X', 485, 171, 9, bold);

  if (preview) {
    for (const pg of [p1, p2]) {
      pg.drawText('UNSIGNED PREVIEW', {
        x: 80, y: 300, size: 60, font: bold,
        color: rgb(0.87, 0.87, 0.87), opacity: 0.22,
        rotate: { type: 'degrees', angle: 45 },
      });
    }
  }

  const f5472FinalBytes = await doc5472.save();

  // ── Pro Forma 1120 cover (prepended) ─────────────────────────────────────
  const cover1120 = await buildProforma1120(company, taxYear, transactions, preview);

  const merged = await PDFDocument.create();
  const [coverPage] = await merged.copyPages(await PDFDocument.load(cover1120), [0]);
  merged.addPage(coverPage);
  const f5472Doc = await PDFDocument.load(f5472FinalBytes);
  const f5472Pages = await merged.copyPages(f5472Doc, [0, 1, 2]);
  for (const pg of f5472Pages) merged.addPage(pg);

  return merged.save();
}

// ─── Pro Forma Form 1120 cover page ─────────────────────────────────────────

async function buildProforma1120(company, taxYear, transactions, preview) {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
  const doc  = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);

  const BLACK = rgb(0, 0, 0);
  const GRAY  = rgb(0.45, 0.45, 0.45);

  const p = doc.addPage([612, 792]);
  const { width, height } = p.getSize();

  const d = (text, x, y, opts = {}) =>
    p.drawText(String(text ?? ''), { x, y, size: opts.size || 10, font: opts.bold ? bold : reg, color: opts.color || BLACK });
  const l = (x1, y1, x2, y2, t = 0.5) =>
    p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: BLACK });
  const box = (x, y, w, h, fill) =>
    p.drawRectangle({ x, y, width: w, height: h, color: fill, borderColor: BLACK, borderWidth: 0.5 });

  const addr = company.address;
  const fullAddr = `${addr.street || ''}, ${addr.city}, ${addr.state} ${addr.zip || ''}`.trim();

  box(36, height - 64, width - 72, 48, rgb(0.06, 0.06, 0.08));
  d('Pro Forma Form 1120',                44, height - 36, { size: 9,  color: rgb(0.6, 0.6, 0.6) });
  d('U.S. Corporation Income Tax Return', 44, height - 50, { size: 16, bold: true, color: rgb(1, 1, 1) });
  d(`Tax Year ${taxYear}`, width - 148,   height - 45, { size: 11, color: rgb(0.55, 0.55, 0.55) });
  d('Department of the Treasury — Internal Revenue Service', 36, height - 76, { size: 8, color: GRAY });
  d('Filed pursuant to Reg. §1.6038A-2 — Foreign-Owned U.S. Disregarded Entity', 36, height - 88, { size: 8, color: GRAY });

  p.drawText('Foreign-Owned U.S. DE', { x: 36, y: height - 108, size: 11, font: bold, color: rgb(0.15, 0.15, 0.15) });
  l(36, height - 110, width - 36, height - 110, 0.7);

  let y = height - 136;

  box(36, y - 4, width - 72, 16, rgb(0.15, 0.15, 0.15));
  d('CORPORATION INFORMATION', 40, y + 4, { size: 8, bold: true, color: rgb(1, 1, 1) });

  y -= 28;
  d('Name of Corporation (LLC):', 36, y, { size: 8, color: GRAY });
  d(company.name, 36, y - 14, { size: 12, bold: true });
  l(36, y - 16, width - 36, y - 16);

  y -= 36;
  d('Employer Identification Number (EIN):', 36, y, { size: 8, color: GRAY });
  d(company.ein, 36, y - 14, { size: 12, bold: true });
  l(36, y - 16, 200, y - 16);
  d('Tax Year End:', 220, y, { size: 8, color: GRAY });
  d(`December 31, ${taxYear}`, 220, y - 14, { size: 12, bold: true });
  l(220, y - 16, 430, y - 16);

  y -= 36;
  d('Address:', 36, y, { size: 8, color: GRAY });
  d(fullAddr, 36, y - 14, { size: 11 });
  l(36, y - 16, width - 36, y - 16);

  y -= 50;
  box(36, y - 4, width - 72, 16, rgb(0.15, 0.15, 0.15));
  d('FILING NOTES', 40, y + 4, { size: 8, bold: true, color: rgb(1, 1, 1) });
  y -= 24;
  const notes = [
    'This pro forma Form 1120 is filed solely to provide a vehicle for attachment of Form 5472.',
    'The corporation is a foreign-owned U.S. disregarded entity (LLC) with no U.S. income tax liability.',
    'Write "Foreign-Owned U.S. DE" across the top of Form 1120 per IRS instructions.',
    'File by fax to IRS PIN Unit: 855-887-7737  |  Ogden, UT 84201 (M/S 6112, Attn: PIN Unit).',
    'Alternatively, mail to: Internal Revenue Service, Ogden, UT 84201-0011.',
  ];
  for (let i = 0; i < notes.length; i++) {
    d(`${i + 1}.  ${notes[i]}`, 44, y - i * 18, { size: 9, color: rgb(0.2, 0.2, 0.2) });
  }

  if (transactions.length > 0) {
    y -= notes.length * 18 + 34;
    box(36, y - 4, width - 72, 16, rgb(0.15, 0.15, 0.15));
    d('TRANSACTION SUMMARY (see Form 5472 for full detail)', 40, y + 4, { size: 8, bold: true, color: rgb(1, 1, 1) });
    y -= 20;

    const fmtUSD = n => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const TX_LABELS = {
      capital_contribution: 'Capital contributed by foreign shareholder',
      distribution:         'Amount distributed to foreign shareholder',
      loan_from_owner:      'Loan received from foreign shareholder',
      loan_to_owner:        'Loan made to foreign shareholder',
      services_paid:        'Consideration paid for services to related party',
      services_received:    'Consideration received for services from related party',
      rent_paid:            'Rent paid to related party',
      rent_received:        'Rent received from related party',
    };

    box(36, y - 2, width - 72, 16, rgb(0.92, 0.92, 0.92));
    d('Transaction', 40, y + 6, { size: 8, bold: true });
    d('Amount (USD)', width - 158, y + 6, { size: 8, bold: true });

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      y -= 22;
      if (i % 2 === 0) box(36, y - 6, width - 72, 20, rgb(0.97, 0.97, 0.97));
      d(TX_LABELS[tx.type] || tx.type, 40, y + 4, { size: 9 });
      d(fmtUSD(tx.amount), width - 155, y + 4, { size: 10, bold: true });
      if (tx.note) d(`Note: ${tx.note}`, 40, y - 6, { size: 7.5, color: GRAY });
    }
  }

  y -= 60;
  box(36, y - 50, width - 72, 70, rgb(0.97, 0.97, 0.97));
  d('SIGNATURE', 44, y + 8, { size: 8, bold: true, color: GRAY });
  d('Under penalties of perjury, I declare that I have examined this return and accompanying schedules', 44, y - 8, { size: 8.5 });
  d('and statements, and to the best of my knowledge and belief, they are true, correct, and complete.', 44, y - 20, { size: 8.5 });
  l(44, y - 36, 300, y - 36);
  d('Signature of officer / authorized representative', 44, y - 46, { size: 7.5, color: GRAY });
  l(320, y - 36, 460, y - 36);
  d('Date', 320, y - 46, { size: 7.5, color: GRAY });
  l(480, y - 36, width - 44, y - 36);
  d('Title', 480, y - 46, { size: 7.5, color: GRAY });

  if (preview) {
    p.drawText('UNSIGNED PREVIEW', {
      x: 80, y: 300, size: 60, font: bold,
      color: rgb(0.87, 0.87, 0.87), opacity: 0.22,
      rotate: { type: 'degrees', angle: 45 },
    });
  }

  d('Form 1120 (Pro Forma) — Attachment to Form 5472', 36, 30, { size: 8, color: GRAY });
  d(`${company.name}  ·  EIN ${company.ein}  ·  Tax Year ${taxYear}`, width / 2 - 80, 30, { size: 8, color: GRAY });

  return doc.save();
}

// ─── Form 1065 + K-1 summary ─────────────────────────────────────────────────

async function generate1065(company, partners, financials, taxYear, preview) {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');

  const doc  = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);

  const BLACK = rgb(0, 0, 0);
  const GRAY  = rgb(0.45, 0.45, 0.45);
  const LGRAY = rgb(0.92, 0.92, 0.92);

  const p = doc.addPage([612, 792]);
  const { width, height } = p.getSize();

  const d = (text, x, y, opts = {}) =>
    p.drawText(String(text ?? ''), { x, y, size: opts.size || 10, font: opts.bold ? bold : reg, color: opts.color || BLACK });
  const l = (x1, y1, x2, y2, t = 0.5) =>
    p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: BLACK });
  const box = (x, y, w, h, fill = LGRAY) =>
    p.drawRectangle({ x, y, width: w, height: h, color: fill, borderColor: BLACK, borderWidth: 0.5 });

  const fmtUSD = n => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  box(36, height - 64, width - 72, 48, rgb(0.06, 0.06, 0.08));
  d('Form 1065', 44, height - 36, { size: 9, color: rgb(0.6, 0.6, 0.6) });
  d('U.S. Return of Partnership Income', 44, height - 50, { size: 14, bold: true, color: rgb(1, 1, 1) });
  d(`Tax Year ${taxYear}`, width - 148, height - 45, { size: 11, color: rgb(0.55, 0.55, 0.55) });
  d('Department of the Treasury — Internal Revenue Service', 36, height - 76, { size: 8, color: GRAY });

  let y = height - 104;

  box(36, y - 4, width - 72, 16, rgb(0.15, 0.15, 0.15));
  d('PARTNERSHIP INFORMATION', 40, y + 4, { size: 8, bold: true, color: rgb(1, 1, 1) });

  y -= 28;
  d('Name of partnership:', 36, y, { size: 8, color: GRAY });
  d(company.name, 36, y - 14, { size: 12, bold: true });
  l(36, y - 16, width - 36, y - 16);

  y -= 34;
  d('EIN:', 36, y, { size: 8, color: GRAY });
  d(company.ein, 36, y - 14, { size: 12, bold: true });
  l(36, y - 16, 200, y - 16);
  d('Tax year end:', 220, y, { size: 8, color: GRAY });
  d(`12/31/${taxYear}`, 220, y - 14, { size: 12, bold: true });

  y -= 34;
  const addr = company.address;
  d('Address:', 36, y, { size: 8, color: GRAY });
  d(`${addr.street || ''}, ${addr.city}, ${addr.state} ${addr.zip || ''}`.trim(), 36, y - 14, { size: 10 });
  l(36, y - 16, width - 36, y - 16);

  y -= 50;
  box(36, y - 4, width - 72, 16, rgb(0.15, 0.15, 0.15));
  d('INCOME & EXPENSES', 40, y + 4, { size: 8, bold: true, color: rgb(1, 1, 1) });

  const rows = [
    ['1a', 'Gross receipts / sales', financials.gross_revenue],
    ['9',  'Salaries and wages',     financials.expenses?.payroll],
    ['14', 'Rent / lease expense',   financials.expenses?.rent],
    ['20', 'Software & Tools',       financials.expenses?.software],
    ['20', 'Professional Services',  financials.expenses?.professional],
    ['20', 'Miscellaneous',          financials.expenses?.other],
  ].filter(r => r[2] != null && Number(r[2]) > 0);

  const totalExp = ['rent','payroll','software','professional','other']
    .reduce((s, k) => s + Number(financials.expenses?.[k] || 0), 0);
  const netIncome = Number(financials.gross_revenue || 0) - totalExp;

  rows.forEach(([line, label, val], i) => {
    y -= 22;
    if (i % 2 === 0) box(36, y - 6, width - 72, 20, rgb(0.97, 0.97, 0.97));
    d(`Line ${line}  ${label}`, 40, y + 4, { size: 9 });
    d(fmtUSD(val), width - 155, y + 4, { size: 10, bold: true });
  });

  y -= 28;
  box(36, y - 4, width - 72, 22, rgb(0.06, 0.06, 0.08));
  d('Ordinary business income (loss)', 40, y + 8, { size: 9, bold: true, color: rgb(1, 1, 1) });
  d(fmtUSD(netIncome), width - 155, y + 8, {
    size: 11, bold: true,
    color: netIncome >= 0 ? rgb(0.3, 0.8, 0.4) : rgb(0.9, 0.3, 0.3),
  });

  y -= 50;
  box(36, y - 4, width - 72, 16, rgb(0.15, 0.15, 0.15));
  d('PARTNERS — SCHEDULE K-1 SUMMARY', 40, y + 4, { size: 8, bold: true, color: rgb(1, 1, 1) });

  y -= 20;
  box(36, y - 2, width - 72, 16, LGRAY);
  d('Partner Name', 40, y + 6, { size: 8, bold: true });
  d('Country', 280, y + 6, { size: 8, bold: true });
  d('Ownership %', 380, y + 6, { size: 8, bold: true });
  d('Allocated Income', width - 160, y + 6, { size: 8, bold: true });

  partners.forEach((pt, i) => {
    y -= 22;
    if (i % 2 === 0) box(36, y - 6, width - 72, 20, rgb(0.97, 0.97, 0.97));
    const pct = Number(pt.ownership_percent || pt.profit_percent || 0);
    d(pt.name, 40, y + 4, { size: 9 });
    d(pt.country, 280, y + 4, { size: 9 });
    d(`${pct}%`, 390, y + 4, { size: 9 });
    d(fmtUSD(netIncome * pct / 100), width - 155, y + 4, { size: 9, bold: true });
  });

  y -= 50;
  box(36, y - 50, width - 72, 68, rgb(0.97, 0.97, 0.97));
  d('SIGNATURE OF GENERAL PARTNER OR MANAGING MEMBER', 44, y + 8, { size: 8, bold: true, color: GRAY });
  d('Under penalties of perjury, I declare that I have examined this return and accompanying schedules and statements,', 44, y - 8, { size: 8.5 });
  d('and to the best of my knowledge and belief, they are true, correct, and complete.', 44, y - 20, { size: 8.5 });
  l(44, y - 36, 300, y - 36);
  d('Signature', 44, y - 46, { size: 7.5, color: GRAY });
  l(320, y - 36, 460, y - 36);
  d('Date', 320, y - 46, { size: 7.5, color: GRAY });

  if (preview) {
    p.drawText('UNSIGNED PREVIEW', {
      x: 80, y: 300, size: 60, font: bold,
      color: rgb(0.87, 0.87, 0.87), opacity: 0.22,
      rotate: { type: 'degrees', angle: 45 },
    });
  }

  d('Form 1065 — U.S. Return of Partnership Income', 36, 40, { size: 8, color: GRAY });
  l(36, 52, width - 36, 52, 0.3);
  d(`${company.name}  ·  EIN ${company.ein}  ·  Tax Year ${taxYear}`, 36, 30, { size: 8, color: GRAY });

  return doc.save();
}
