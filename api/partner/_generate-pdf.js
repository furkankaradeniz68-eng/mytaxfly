// Node.js port of dashboard.html's buildIRSAcroBlob().
// Produces identical PDFs to the MyTaxFly dashboard — same layout, same
// section structure, same line numbers — from Partner API request data.
//
// Differences from the browser version:
//   - pdf-lib imported as an ES module (no PDFLib global)
//   - Signature decoded with Buffer.from() instead of atob()
//   - Returns Uint8Array, not Blob
//   - Input is the Partner API shape, not a user-account profile

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// ── Transaction types that count as income / expense ─────────────────────────
const INCOME_TYPES  = new Set(['services_received', 'rent_received',  'royalties_received', 'loan_to_owner']);
const EXPENSE_TYPES = new Set(['services_paid',     'rent_paid',      'royalties_paid',     'loan_from_owner', 'capital_contribution', 'distribution']);

// Maps Partner API transaction types → Form 5472 Part IV line numbers
// Line 17 = amounts RECEIVED (borrowed FROM owner) — Part IV received section
// Line 31 = amounts PAID (loaned TO owner) — Part IV paid section
const TX_LINE_MAP = {
  services_received:  '15',
  loan_from_owner:    '17',   // LLC borrowed FROM owner → received section
  rent_received:      '13a',
  royalties_received: '13b',
  services_paid:      '29',
  loan_to_owner:      '31',   // LLC loaned TO owner → paid section
  rent_paid:          '27a',
  royalties_paid:     '27b',
};
const LINE_LABELS = {
  '13a': 'Rents received',
  '13b': 'Royalties received',
  '15':  'Consideration received for services',
  '17a': 'Amounts borrowed from related party — beginning of year',
  '17b': 'Amounts borrowed from related party — end of year',
  '22':  'Total — combine amounts on lines 9 through 21',
  '27a': 'Rents paid',
  '27b': 'Royalties paid',
  '29':  'Consideration paid for services',
  '31a': 'Amounts loaned to related party — beginning of year',
  '31b': 'Amounts loaned to related party — end of year',
  '35':  'Other amounts paid or accrued',
  '36':  'Total — combine amounts on lines 23 through 35',
};

/**
 * @param {object} opts
 * @param {'5472_1120'|'1065'|'7004'|'1120'|'5472'} opts.form_type
 * @param {object}   opts.company
 * @param {object}   [opts.foreign_owner]
 * @param {object[]} [opts.transactions]  — Partner API transaction objects
 * @param {object[]} [opts.partners]      — for 1065 K-1 section
 * @param {object}   [opts.financials]    — { gross_revenue, expenses: {...} }
 * @param {number}   opts.tax_year
 * @param {boolean}  [opts.preview]       — adds UNSIGNED PREVIEW watermark
 * @param {string}   [opts.signature_png_base64]  — data URL or raw base64
 * @param {string}   [opts.extend_form]   — for 7004: '1065'|'1120'|'1120-S'|'1120-F'|'1041'
 * @returns {Promise<Uint8Array>}
 */
export async function generatePdf({
  form_type,
  company,
  foreign_owner,
  transactions = [],
  partners     = [],
  financials   = {},
  tax_year,
  preview      = false,
  signature_png_base64 = null,
  extend_form  = '1120',
}) {
  // ── Derive inc / exp / profit / cats from financials + transactions ─────────
  let inc, exp;
  if (financials.gross_revenue != null) {
    inc = Number(financials.gross_revenue);
    exp = Object.values(financials.expenses || {}).reduce((s, v) => s + Number(v || 0), 0);
  } else {
    inc = transactions.filter(t => INCOME_TYPES.has(t.type)).reduce((s, t) => s + Number(t.amount || 0), 0);
    exp = transactions.filter(t => EXPENSE_TYPES.has(t.type)).reduce((s, t) => s + Number(t.amount || 0), 0);
  }
  const profit = inc - exp;

  // Expense category breakdown (mirrors dashboard's `cats` object)
  const cats = {};
  if (financials.expenses && Object.keys(financials.expenses).length) {
    const EXPENSE_LABELS = {
      payroll:      'Salaries and wages',
      rent:         'Rent / lease expense',
      software:     'Software and tools',
      professional: 'Professional services',
      other:        'Other expenses',
    };
    Object.entries(financials.expenses).forEach(([k, v]) => {
      if (Number(v) > 0) cats[EXPENSE_LABELS[k] || k] = Number(v);
    });
  } else {
    transactions.filter(t => EXPENSE_TYPES.has(t.type)).forEach(t => {
      const label = t.type.replace(/_/g, ' ');
      cats[label] = (cats[label] || 0) + Number(t.amount || 0);
    });
  }

  const advAmt   = Object.entries(cats).filter(([k]) => /advertis|marketing/i.test(k)).reduce((s, [, v]) => s + v, 0);
  const otherDed = Math.max(0, exp - advAmt);

  // Build a filtered-style array for transaction count lines
  const filteredIncome  = transactions.filter(t => INCOME_TYPES.has(t.type));
  const filteredExpense = transactions.filter(t => EXPENSE_TYPES.has(t.type));

  // Shortcuts for company/profile fields (mirrors dashboard's `p` + `addr`)
  const addr         = company.address || {};
  const street       = addr.street || '';
  const cityStateZip = [addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
  const ein          = company.ein || '';
  const corpName     = company.name || '';
  const taxYear      = tax_year;
  const todayStr     = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const ownerTitle   = company.title || 'Owner / Managing Member';
  const ownerName    = company.owner_name || corpName;
  const owner        = foreign_owner || {};
  const extendForm   = extend_form;
  const sigData      = signature_png_base64;

  // ── pdf-lib setup ──────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const W = 612, H = 792, ML = 48, MR = 48, IW = W - ML - MR;
  const BLACK = rgb(0,0,0), WHITE = rgb(1,1,1);
  const GRAY3 = rgb(0.3,0.3,0.3), GRAY6 = rgb(0.6,0.6,0.6);
  const LGRAY = rgb(0.93,0.93,0.93), DGRAY = rgb(0.13,0.13,0.13);

  function irs(n)    { return Math.round(Math.abs(n)).toLocaleString('en-US'); }
  function dollar(n) { return '$ ' + irs(n); }

  // ── Drawing helpers (identical to dashboard) ───────────────────────────────
  const hline = (pg, y, x0=ML, x1=W-MR, w=0.4, c=rgb(0.7,0.7,0.7)) =>
    pg.drawLine({start:{x:x0,y},end:{x:x1,y},thickness:w,color:c});
  const vline = (pg, x, y0, y1, w=0.4, c=rgb(0.7,0.7,0.7)) =>
    pg.drawLine({start:{x,y:y0},end:{x,y:y1},thickness:w,color:c});
  const box = (pg, x, y, w, h, fill, stroke) => {
    if (fill)   pg.drawRectangle({x,y,width:w,height:h,color:fill});
    if (stroke) pg.drawRectangle({x,y,width:w,height:h,borderColor:stroke,borderWidth:0.5});
  };
  const t = (pg, s, x, y, sz=8.5, f=font, c=BLACK) => {
    if (s == null || s === '') return;
    pg.drawText(String(s), {x, y, size:sz, font:f, color:c});
  };
  const tR = (pg, s, rx, y, sz=8.5, f=font, c=BLACK) => {
    if (s == null || s === '') return;
    const str = String(s);
    pg.drawText(str, {x: rx - f.widthOfTextAtSize(str, sz), y, size:sz, font:f, color:c});
  };

  // Embed signature (Node.js: Buffer instead of atob)
  async function drawSig(page, x, y, maxW=150, maxH=32) {
    if (!sigData) return;
    try {
      const b64   = sigData.includes(',') ? sigData.split(',')[1] : sigData;
      const bytes = Buffer.from(b64, 'base64');
      const img   = await pdfDoc.embedPng(bytes);
      const { width, height } = img.scale(1);
      const scale = Math.min(maxW/width, maxH/height, 1);
      page.drawImage(img, {x, y, width:width*scale, height:height*scale});
    } catch(e) { /* silent — sig is optional */ }
  }

  // Preview watermark overlay
  function stampPreview(pages) {
    pages.forEach(pg => {
      pg.drawText('UNSIGNED PREVIEW', {
        x:60, y:320, size:56, font:fontB,
        color:rgb(0.87,0.87,0.87), opacity:0.22,
        rotate:{type:'degrees',angle:45},
      });
    });
  }

  // ── Reusable layout blocks (identical to dashboard) ────────────────────────

  function pageHeader(pg, formNum, title, pageNum, totalPages) {
    box(pg, 0, H-34, W, 34, DGRAY, null);
    t(pg, 'Form', ML, H-23, 9, font, rgb(0.65,0.65,0.65));
    t(pg, formNum, ML+28, H-24, 13, fontB, WHITE);
    const nw = fontB.widthOfTextAtSize(formNum, 13);
    t(pg, title, ML+32+nw, H-23, 8, font, rgb(0.75,0.75,0.75));
    tR(pg, `Tax Year ${taxYear}  |  Page ${pageNum} of ${totalPages}`, W-MR, H-23, 7.5, font, rgb(0.6,0.6,0.6));
    hline(pg, H-34, 0, W, 0.5, DGRAY);
    t(pg, 'Department of the Treasury - Internal Revenue Service', ML, H-44, 6.5, font, GRAY6);
  }

  function sectionBar(pg, y, label, sub='') {
    box(pg, ML, y-13, IW, 13, rgb(0.18,0.18,0.18), null);
    t(pg, label, ML+4, y-10, 7.5, fontB, WHITE);
    if (sub) tR(pg, sub, W-MR-4, y-10, 7, font, rgb(0.7,0.7,0.7));
    return y - 13;
  }

  function companyBlock(pg, startY) {
    const BH = 76;
    box(pg, ML, startY-BH, IW, BH, LGRAY, null);
    box(pg, ML, startY-BH, IW, BH, null, rgb(0.55,0.55,0.55));
    const DX = ML + IW*0.62;
    vline(pg, DX, startY-BH, startY, 0.5, rgb(0.55,0.55,0.55));

    t(pg, 'Name of Corporation / LLC',  ML+4, startY-9,  6.5, font, GRAY6);
    t(pg, corpName||'(not set)',         ML+4, startY-21, 9,   fontB, BLACK);
    t(pg, 'Street address',             ML+4, startY-34, 6.5, font, GRAY6);
    t(pg, street||'(not set)',           ML+4, startY-46, 8.5, font, BLACK);
    t(pg, 'City, State, ZIP',           ML+4, startY-59, 6.5, font, GRAY6);
    t(pg, cityStateZip||'(not set)',     ML+4, startY-71, 8.5, font, BLACK);

    const rx = DX + 6;
    t(pg, 'Employer Identification Number', rx, startY-9,  6.5, font, GRAY6);
    t(pg, ein||'(not set)',                 rx, startY-21, 9,   fontB, BLACK);
    t(pg, 'Total Assets',                   rx, startY-34, 6.5, font, GRAY6);
    t(pg, dollar(inc),                      rx, startY-46, 8.5, font, BLACK);
    t(pg, 'Tax period',                     rx, startY-59, 6.5, font, GRAY6);
    t(pg, `01/01/${taxYear} - 12/31/${taxYear}`, rx, startY-71, 8, font, BLACK);

    return startY - BH;
  }

  function lineRow(pg, y, num, label, val, bold=false, indent=0) {
    hline(pg, y, ML, W-MR);
    const f = bold ? fontB : font;
    if (num) t(pg, num, ML+3, y-11, 7.5, fontB, GRAY3);
    t(pg, label, ML+22+indent, y-11, 8, f, BLACK);
    if (val !== null && val !== undefined && val !== '') tR(pg, val, W-MR-4, y-11, 8.5, fontB, BLACK);
    return y - 15;
  }

  async function sigBlock(pg, y) {
    const BH = 82;
    y -= 8;
    box(pg, ML, y-BH, IW, BH, null, BLACK);
    box(pg, ML, y-14, IW, 14, LGRAY, null);
    t(pg, 'SIGN HERE', ML+4, y-11, 7.5, fontB, GRAY3);
    t(pg, 'Under penalties of perjury, I declare that I have examined this return and to the best of my knowledge and belief, it is true, correct, and complete.', ML+70, y-11, 6.5, font, GRAY3);
    y -= 14;

    t(pg, 'Signature of officer',         ML+4,   y-8,  6.5, font, GRAY6);
    hline(pg, y-22, ML+4,   ML+195, 0.7, BLACK);
    await drawSig(pg, ML+6, y-23, 188, 19);
    t(pg, 'Date',                         ML+205, y-8,  6.5, font, GRAY6);
    hline(pg, y-22, ML+205, ML+330, 0.7, BLACK);
    t(pg, todayStr,                        ML+208, y-21, 8.5, font, BLACK);
    t(pg, 'Title',                        ML+340, y-8,  6.5, font, GRAY6);
    hline(pg, y-22, ML+340, W-MR-4, 0.7, BLACK);
    t(pg, ownerTitle,                      ML+343, y-21, 8.5, font, BLACK);
    y -= 30;

    t(pg, 'Print / Type name',  ML+4,   y-8,  6.5, font, GRAY6);
    hline(pg, y-22, ML+4,   ML+260, 0.7, BLACK);
    t(pg, ownerName,             ML+7,   y-21, 8.5, font, BLACK);
    t(pg, 'Phone number',       ML+270, y-8,  6.5, font, GRAY6);
    hline(pg, y-22, ML+270, W-MR-4, 0.7, BLACK);
    y -= 30;

    return y;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FORM 1120  (Pro Forma — U.S. Corporation Income Tax Return)
  // ══════════════════════════════════════════════════════════════════════════
  async function build1120() {
    const pg = pdfDoc.addPage([W, H]);
    pageHeader(pg, '1120', 'U.S. Corporation Income Tax Return (Pro Forma)', 1, 2);
    // IRS Form 5472 instructions (Rev. Dec 2024): write "Foreign-Owned U.S. DE" across the top of the pro forma 1120
    const foStamp = 'FOREIGN-OWNED U.S. DE';
    const foSz = 13;
    pg.drawText(foStamp, {
      x: W / 2 - fontB.widthOfTextAtSize(foStamp, foSz) / 2,
      y: H - 52,
      size: foSz,
      font: fontB,
      color: rgb(0.78, 0, 0),
    });
    t(pg, `Reg. sec.1.6012-2(g)(2)  ·  Tax year Jan 01, ${taxYear} – Dec 31, ${taxYear}`, ML, H-62, 6.5, font, GRAY6);

    let y = H - 72;
    y = companyBlock(pg, y);

    y -= 4;
    box(pg, ML, y-13, IW, 13, rgb(0.97,0.97,0.97), null);
    t(pg, '[X]  Foreign-owned U.S. disregarded entity (Reg. sec.1.6012-2(g)(2))', ML+6, y-10, 7.5, font, BLACK);
    y -= 13; y -= 4;

    y = sectionBar(pg, y, 'INCOME');
    y = lineRow(pg, y, '1a', 'Gross receipts or sales',                        irs(inc));
    y = lineRow(pg, y, '1b', 'Returns and allowances',                         '0', false, 8);
    y = lineRow(pg, y, '1c', 'Balance (line 1a minus line 1b)',                 irs(inc), true);
    y = lineRow(pg, y, '2',  'Cost of goods sold',                             '0', false, 8);
    y = lineRow(pg, y, '3',  'Gross profit (line 1c minus line 2)',             irs(inc), true);
    y = lineRow(pg, y, '4',  'Dividends and inclusions',                       '0');
    y = lineRow(pg, y, '5',  'Interest',                                       '0');
    y = lineRow(pg, y, '6',  'Gross rents',                                    '0');
    y = lineRow(pg, y, '7',  'Gross royalties',                                '0');
    y = lineRow(pg, y, '8',  'Capital gain net income',                        '0');
    y = lineRow(pg, y, '9',  'Net gain or (loss) — Form 4797',                 '0');
    y = lineRow(pg, y, '10', 'Other income',                                   '0');
    y = lineRow(pg, y, '11', 'Total income — add lines 3 through 10',          irs(inc), true);
    y -= 4;

    y = sectionBar(pg, y, 'DEDUCTIONS');
    if (advAmt > 0) y = lineRow(pg, y, '22', 'Advertising', irs(advAmt));
    Object.entries(cats).sort(([,a],[,b]) => b-a).slice(0,4).forEach(([cn, ca]) => {
      if (ca > 0 && !/advertis|marketing/i.test(cn))
        y = lineRow(pg, y, '', cn, irs(ca), false, 8);
    });
    y = lineRow(pg, y, '26', 'Other deductions (attach statement)',             irs(otherDed));
    y = lineRow(pg, y, '27', 'Total deductions — add lines 12 through 26',     irs(exp), true);
    y -= 4;

    y = sectionBar(pg, y, 'TAX COMPUTATION');
    y = lineRow(pg, y, '28', 'Taxable income before NOL deduction',            irs(profit));
    y = lineRow(pg, y, '29', 'Net operating loss deduction',                   '0', false, 8);
    y = lineRow(pg, y, '30', 'Taxable income (line 28 minus line 29)',          irs(profit), true);
    y = lineRow(pg, y, '31', 'Total tax — DE is a disregarded entity; no separate U.S. tax liability', '0', true);
    y -= 4;

    await sigBlock(pg, y);

    // Page 2: Expense detail + disclaimer
    const pg2 = pdfDoc.addPage([W, H]);
    pageHeader(pg2, '1120', 'U.S. Corporation Income Tax Return (Pro Forma) — Supplemental', 2, 2);
    let y2 = H - 58;

    t(pg2, 'Transaction & Category Summary', ML, y2, 10, fontB, BLACK); y2 -= 20;

    y2 = sectionBar(pg2, y2, 'FINANCIAL SUMMARY');
    y2 = lineRow(pg2, y2, '', `Total income transactions (${filteredIncome.length})`,  irs(inc));
    y2 = lineRow(pg2, y2, '', `Total expense transactions (${filteredExpense.length})`, irs(exp));
    y2 = lineRow(pg2, y2, '', 'Net profit / (loss)',                                   irs(profit), true);
    y2 -= 8;

    if (Object.keys(cats).length) {
      y2 = sectionBar(pg2, y2, 'EXPENSE CATEGORIES (Deduction Detail)');
      Object.entries(cats).sort(([,a],[,b]) => b-a).forEach(([cn, ca]) => {
        if (ca > 0) y2 = lineRow(pg2, y2, '', cn, irs(ca));
      });
      y2 = lineRow(pg2, y2, '', 'TOTAL DEDUCTIONS', irs(exp), true);
    }

    y2 -= 20;
    box(pg2, ML, y2-32, IW, 32, rgb(1,0.97,0.91), null);
    box(pg2, ML, y2-32, IW, 32, null, rgb(0.85,0.65,0.2));
    t(pg2, '(!)  DISCLAIMER', ML+6, y2-11, 7.5, fontB, rgb(0.5,0.3,0));
    t(pg2, 'This is a pro forma informational return for a foreign-owned U.S. disregarded entity. The entity has no separate U.S.', ML+6, y2-21, 6.5, font, rgb(0.45,0.28,0));
    t(pg2, 'federal income tax liability. Form 5472 is filed as an attachment per Reg. sec.1.6038A-1. Consult a licensed CPA before filing.', ML+6, y2-31, 6.5, font, rgb(0.45,0.28,0));

    if (preview) stampPreview([pg, pg2]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FORM 5472
  // ══════════════════════════════════════════════════════════════════════════
  async function build5472() {
    const fmtUSD = n => `$${Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2})}`;

    // Extract loan balances (17a/17b and 31a/31b need beginning + ending separately)
    const loanFromTxs = transactions.filter(t => t.type === 'loan_from_owner');
    const loanToTxs   = transactions.filter(t => t.type === 'loan_to_owner');
    const loanFromBeg = loanFromTxs.reduce((s, t) => s + Number(t.amount_beginning || 0), 0);
    const loanFromEnd = loanFromTxs.reduce((s, t) => s + Number(t.amount_ending ?? t.amount ?? 0), 0);
    const loanToBeg   = loanToTxs.reduce((s, t) => s + Number(t.amount_beginning || 0), 0);
    const loanToEnd   = loanToTxs.reduce((s, t) => s + Number(t.amount_ending ?? t.amount ?? 0), 0);

    // capital_contribution / distribution → Part V (no Part IV line)
    const capitalContrib  = transactions.filter(t => t.type === 'capital_contribution').reduce((s, t) => s + Number(t.amount || 0), 0);
    const distributions   = transactions.filter(t => t.type === 'distribution').reduce((s, t) => s + Number(t.amount || 0), 0);

    // Aggregate amounts per Part IV line (exclude loans — handled separately above)
    const lineAmounts = {};
    transactions.forEach(tx => {
      if (tx.type === 'loan_from_owner' || tx.type === 'loan_to_owner') return;
      const line = TX_LINE_MAP[tx.type];
      if (line) lineAmounts[line] = (lineAmounts[line] || 0) + Number(tx.amount || 0);
    });

    // Fall back to aggregate inc/exp if no transaction-level data
    const totalReceived = lineAmounts['22'] ||
      Object.entries(lineAmounts).filter(([k]) => ['13a','13b','15','18','19','20','21'].includes(k)).reduce((s,[,v]) => s+v, 0) + loanFromEnd ||
      inc;
    const totalPaid = lineAmounts['36'] ||
      Object.entries(lineAmounts).filter(([k]) => ['23','24','25','26','27a','27b','28','29','30','32','33','34','35'].includes(k)).reduce((s,[,v]) => s+v, 0) + loanToEnd ||
      exp;

    // ── Page 1: Parts I – III + Part IV received ──────────────────────────
    const pg = pdfDoc.addPage([W, H]);
    pageHeader(pg, '5472', 'Information Return of a 25% Foreign-Owned U.S. Corporation (Rev. December 2023)', 1, 3);
    t(pg, `For tax year of the reporting corporation beginning 01/01/${taxYear} and ending 12/31/${taxYear}`, ML, H-47, 7, font, GRAY6);

    let y = H - 58;

    y = sectionBar(pg, y, 'PART I — REPORTING CORPORATION');
    y -= 4;

    const GH = 26, DX = ML + IW*0.62;
    const gridTop = y;
    box(pg, ML, gridTop - GH*4 - 26, IW, GH*4+26, LGRAY, null);
    box(pg, ML, gridTop - GH*4 - 26, IW, GH*4+26, null, rgb(0.55,0.55,0.55));
    vline(pg, DX, gridTop-GH*4-26, gridTop);

    const cell = (row, col, label, val, boldVal=false) => {
      const cy = gridTop - row*GH;
      const cx = col === 0 ? ML : DX;
      const cw = col === 0 ? DX - ML : W-MR - DX;
      if (row > 0) hline(pg, cy, cx, cx+cw, 0.5, rgb(0.55,0.55,0.55));
      t(pg, label, cx+4, cy-8,  6.5, font, GRAY6);
      t(pg, val,   cx+4, cy-20, 8.5, boldVal ? fontB : font, BLACK);
    };

    cell(1, 0, '1a  Name of reporting corporation',                                corpName, true);
    cell(1, 1, '1b  Employer identification number (EIN)',                         ein, true);
    cell(2, 0, '    Number, street, and room or suite no.',                        street);
    cell(2, 1, '1c  Total assets',                                                 dollar(company.total_assets ?? inc));
    cell(3, 0, '    City or town, state, and ZIP code',                            cityStateZip);
    cell(3, 1, '1d/1e  Business activity' + (company.naics_code ? `  (NAICS: ${company.naics_code})` : ''), company.business_activity || 'Professional Services');
    cell(4, 0, '1f  Total gross payments made or received on this Form 5472',      dollar(totalReceived + totalPaid));
    cell(4, 1, company.incorporated_date ? `1m  Date incorporated: ${company.incorporated_date}` : '1g  Total number of Forms 5472 filed for the tax year', company.incorporated_date || '1');

    y = gridTop - GH*4 - 26;
    box(pg, ML, y-22, IW, 22, rgb(0.97,0.97,0.97), null);
    box(pg, ML, y-22, IW, 22, null, rgb(0.55,0.55,0.55));
    t(pg, '3  [X]  This is a foreign-owned domestic disregarded entity (DE) treated as a corporation for purposes of section 6038A.', ML+4, y-15, 7.5, font, BLACK);
    y -= 22; y -= 10;

    y = sectionBar(pg, y, 'PART II — 25% FOREIGN SHAREHOLDER');
    y -= 4;

    const P2H = 26;
    box(pg, ML, y - P2H*3, IW, P2H*3, LGRAY, null);
    box(pg, ML, y - P2H*3, IW, P2H*3, null, rgb(0.55,0.55,0.55));
    t(pg, '4a  Name and address of direct 25% foreign shareholder', ML+4, y-8, 6.5, font, GRAY6);
    t(pg, owner.name||'(see attachment)', ML+4, y-20, 8.5, font, BLACK);
    hline(pg, y-P2H, ML, W-MR, 0.5, rgb(0.55,0.55,0.55));

    const thirdW = IW/3;
    vline(pg, ML+thirdW,   y-P2H*3, y-P2H);
    vline(pg, ML+thirdW*2, y-P2H*3, y-P2H);
    t(pg, '4b(1)  U.S. identifying number, if any', ML+4,          y-P2H-8,  6.5, font, GRAY6);
    t(pg, owner.us_tin||'N/A',                       ML+4,          y-P2H-20, 8.5, font, BLACK);
    t(pg, '4b(2)  Reference ID number',              ML+thirdW+4,  y-P2H-8,  6.5, font, GRAY6);
    t(pg, owner.ref_id||'',                          ML+thirdW+4,  y-P2H-20, 8.5, font, BLACK);
    t(pg, '4b(3)  FTIN, if any',                    ML+thirdW*2+4, y-P2H-8,  6.5, font, GRAY6);
    t(pg, owner.ftin||'',                            ML+thirdW*2+4, y-P2H-20, 8.5, font, BLACK);
    hline(pg, y-P2H*2, ML, W-MR, 0.5, rgb(0.55,0.55,0.55));
    t(pg, '4c  Country under whose laws the shareholder files as a resident', ML+4, y-P2H*2-8, 6.5, font, GRAY6);
    t(pg, owner.country||'', ML+4, y-P2H*2-20, 8.5, font, BLACK);
    y -= P2H*3; y -= 10;

    y = sectionBar(pg, y, 'PART III — RELATED PARTY INFORMATION');
    y -= 4;
    box(pg, ML, y-22, IW, 22, LGRAY, null);
    box(pg, ML, y-22, IW, 22, null, rgb(0.55,0.55,0.55));
    t(pg, '8a  Name and address of related party (same as 25% foreign shareholder for single-member LLC)', ML+4, y-8, 6.5, font, GRAY6);
    t(pg, (owner.name||'(same as Part II)') + '  --  Check: [X] Foreign person  [ ] U.S. person', ML+4, y-19, 7.5, font, BLACK);
    y -= 22; y -= 10;

    y = sectionBar(pg, y, 'PART IV — MONETARY TRANSACTIONS BETWEEN REPORTING CORPORATION AND FOREIGN RELATED PARTY');
    t(pg, 'Caution: Part IV must be completed if the "foreign person" box is checked in Part III.', ML+4, y-10, 6.5, font, GRAY3);
    y -= 14;

    // AMOUNTS RECEIVED — show per-type lines when data is available
    y = sectionBar(pg, y, '  AMOUNTS RECEIVED BY REPORTING CORPORATION', 'Lines 9 – 22');
    const receivedLines = ['13a','13b','15','18'];
    receivedLines.forEach(line => {
      const amt = lineAmounts[line] || (line === '15' && !Object.keys(lineAmounts).length ? inc : 0);
      y = lineRow(pg, y, line, LINE_LABELS[line] || `Line ${line}`, amt > 0 ? irs(amt) : '0');
    });
    // Lines 17a/17b — amounts borrowed from related party (beginning + ending balance)
    y = lineRow(pg, y, '17a', LINE_LABELS['17a'], loanFromBeg > 0 ? irs(loanFromBeg) : '0');
    y = lineRow(pg, y, '17b', LINE_LABELS['17b'], loanFromEnd > 0 ? irs(loanFromEnd) : '0');
    y = lineRow(pg, y, '22',  LINE_LABELS['22'],  irs(totalReceived), true);
    y -= 4;

    // ── Page 2: Amounts PAID + transaction detail ──────────────────────────
    const pg2 = pdfDoc.addPage([W, H]);
    pageHeader(pg2, '5472', 'Information Return of a 25% Foreign-Owned U.S. Corporation — Part IV (continued)', 2, 3);
    let y2 = H - 58;

    y2 = sectionBar(pg2, y2, '  AMOUNTS PAID OR ACCRUED BY REPORTING CORPORATION', 'Lines 23 – 36');
    const paidLines = ['27a','27b','29','35'];
    paidLines.forEach(line => {
      const amt = lineAmounts[line] || (line === '35' && !Object.keys(lineAmounts).length ? exp : 0);
      y2 = lineRow(pg2, y2, line, LINE_LABELS[line] || `Line ${line}`, amt > 0 ? irs(amt) : '0');
    });
    // Lines 31a/31b — amounts loaned to related party (beginning + ending balance)
    y2 = lineRow(pg2, y2, '31a', LINE_LABELS['31a'], loanToBeg > 0 ? irs(loanToBeg) : '0');
    y2 = lineRow(pg2, y2, '31b', LINE_LABELS['31b'], loanToEnd > 0 ? irs(loanToEnd) : '0');
    y2 = lineRow(pg2, y2, '36',  LINE_LABELS['36'],  irs(totalPaid), true);
    y2 -= 14;

    // Net summary box
    box(pg2, ML, y2-50, IW, 50, LGRAY, null);
    box(pg2, ML, y2-50, IW, 50, null, BLACK);
    t(pg2, 'MONETARY TRANSACTION SUMMARY', ML+4, y2-11, 7.5, fontB, GRAY3);
    hline(pg2, y2-14, ML, W-MR, 0.5, rgb(0.6,0.6,0.6));
    t(pg2, 'Total gross payments received (Line 22):',       ML+8, y2-27, 8, font, BLACK);
    tR(pg2, dollar(totalReceived),                           W-MR-8, y2-27, 8.5, fontB, BLACK);
    t(pg2, 'Total gross payments paid or accrued (Line 36):', ML+8, y2-40, 8, font, BLACK);
    tR(pg2, dollar(totalPaid),                               W-MR-8, y2-40, 8.5, fontB, BLACK);
    y2 -= 60;

    // Individual transaction detail (if transactions provided)
    if (transactions.length > 0) {
      y2 -= 10;
      y2 = sectionBar(pg2, y2, 'TRANSACTION DETAIL');
      const TX_LABELS = {
        capital_contribution: 'Capital contributed by foreign shareholder → Part V, Line 37',
        distribution:         'Distribution to foreign shareholder → Part V, Line 38',
        loan_from_owner:      'Amounts borrowed from related party (Lines 17a/17b)',
        loan_to_owner:        'Amounts loaned to related party (Lines 31a/31b)',
        services_paid:        'Consideration paid for services',
        services_received:    'Consideration received for services',
        rent_paid:            'Rent paid to related party',
        rent_received:        'Rent received from related party',
        royalties_paid:       'Royalties paid',
        royalties_received:   'Royalties received',
      };
      box(pg2, ML, y2-2, IW, 16, LGRAY, null);
      t(pg2, 'Transaction type', ML+4, y2+4, 7.5, fontB, GRAY3);
      tR(pg2, 'Amount', W-MR-4, y2+4, 7.5, fontB, GRAY3);
      transactions.forEach((tx, i) => {
        y2 -= 18;
        if (i % 2 === 0) box(pg2, ML, y2-4, IW, 18, rgb(0.97,0.97,0.97), null);
        t(pg2, TX_LABELS[tx.type]||tx.type, ML+4, y2+2, 8, font, BLACK);
        if (tx.note) t(pg2, `(${tx.note})`, ML+4, y2-8, 7, font, GRAY6);
        const displayAmt = tx.type === 'loan_from_owner' || tx.type === 'loan_to_owner'
          ? `Beg: ${fmtUSD(tx.amount_beginning || 0)}  /  End: ${fmtUSD(tx.amount_ending ?? tx.amount ?? 0)}`
          : fmtUSD(tx.amount);
        tR(pg2, displayAmt, W-MR-4, y2+2, tx.type.startsWith('loan') ? 7 : 8.5, fontB, BLACK);
      });
    }

    // ── Page 3: Part V — Foreign-Owned U.S. DE (IRS-required) ────────────────
    const pg3 = pdfDoc.addPage([W, H]);
    pageHeader(pg3, '5472', 'Information Return of a 25% Foreign-Owned U.S. Corporation — Part V', 3, 3);
    let y3 = H - 58;

    y3 = sectionBar(pg3, y3, 'PART V — REPORTABLE TRANSACTIONS OF A FOREIGN-OWNED DOMESTIC DISREGARDED ENTITY');
    t(pg3, 'Required for all foreign-owned U.S. disregarded entities per Reg. sec. 1.6038A-2(b)(7)(x).', ML+4, y3-10, 6.5, font, GRAY3);
    y3 -= 18;

    y3 = lineRow(pg3, y3, '37', 'Total contributions made to the DE by the foreign person (capital contributions)', capitalContrib > 0 ? irs(capitalContrib) : '0');
    y3 = lineRow(pg3, y3, '38', 'Total distributions made from the DE to the foreign person',                       distributions  > 0 ? irs(distributions)  : '0');
    y3 = lineRow(pg3, y3, '39', 'Gross receipts of the DE from all sources',                                        irs(inc));
    y3 = lineRow(pg3, y3, '40', 'Total deductions of the DE',                                                       irs(exp));
    y3 = lineRow(pg3, y3, '41', 'Net income (loss) of the DE (line 39 minus line 40)',                              irs(profit), true);
    y3 = lineRow(pg3, y3, '42', 'Total assets of the DE at end of year',                                            irs(company.total_assets ?? inc));
    y3 -= 14;

    // Part V summary box
    box(pg3, ML, y3-68, IW, 68, LGRAY, null);
    box(pg3, ML, y3-68, IW, 68, null, BLACK);
    t(pg3, 'PART V SUMMARY', ML+4, y3-11, 7.5, fontB, GRAY3);
    hline(pg3, y3-14, ML, W-MR, 0.5, rgb(0.6,0.6,0.6));
    t(pg3, 'Capital contributions from foreign owner (Line 37):', ML+8, y3-27, 8, font, BLACK);
    tR(pg3, dollar(capitalContrib), W-MR-8, y3-27, 8.5, fontB, BLACK);
    t(pg3, 'Distributions to foreign owner (Line 38):', ML+8, y3-40, 8, font, BLACK);
    tR(pg3, dollar(distributions), W-MR-8, y3-40, 8.5, fontB, BLACK);
    t(pg3, 'Net income / (loss) of the DE (Line 41):', ML+8, y3-53, 8, font, BLACK);
    tR(pg3, dollar(profit), W-MR-8, y3-53, 8.5, fontB, BLACK);
    t(pg3, 'Total assets at year-end (Line 42):', ML+8, y3-66, 8, font, BLACK);
    tR(pg3, dollar(company.total_assets ?? inc), W-MR-8, y3-66, 8.5, fontB, BLACK);
    y3 -= 76;

    // Disclaimer
    y3 -= 6;
    box(pg3, ML, y3-32, IW, 32, rgb(1,0.97,0.91), null);
    box(pg3, ML, y3-32, IW, 32, null, rgb(0.85,0.65,0.2));
    t(pg3, '(!)  DISCLAIMER', ML+6, y3-10, 7.5, fontB, rgb(0.5,0.3,0));
    t(pg3, 'This is a pro forma informational return for a foreign-owned U.S. disregarded entity. The entity has no separate U.S.', ML+6, y3-21, 6.5, font, rgb(0.45,0.28,0));
    t(pg3, 'federal income tax liability. Form 5472 is filed as an attachment per Reg. sec.1.6038A-1. Consult a licensed CPA before filing.', ML+6, y3-31, 6.5, font, rgb(0.45,0.28,0));

    if (preview) stampPreview([pg, pg2, pg3]);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FORM 1065  (Partnership Return — Multi-Member LLC)
  // ══════════════════════════════════════════════════════════════════════════
  async function build1065() {
    const fmtUSD = n => `$${Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2})}`;
    const netIncome = profit;
    const totalPages = 1 + partners.length; // 1065 page + one K-1 per partner

    const pg = pdfDoc.addPage([W, H]);
    pageHeader(pg, '1065', 'U.S. Return of Partnership Income', 1, totalPages);
    t(pg, `For calendar year ${taxYear} - beginning 01/01/${taxYear} and ending 12/31/${taxYear}`, ML, H-47, 7, font, GRAY6);

    let y = H - 58;
    y = companyBlock(pg, y);
    y -= 8;

    y = sectionBar(pg, y, 'INCOME');
    y = lineRow(pg, y, '1a', 'Gross receipts or sales',                           irs(inc));
    y = lineRow(pg, y, '1b', 'Returns and allowances',                            '0', false, 8);
    y = lineRow(pg, y, '1c', 'Balance (line 1a minus line 1b)',                    irs(inc), true);
    y = lineRow(pg, y, '2',  'Cost of goods sold',                                '0', false, 8);
    y = lineRow(pg, y, '3',  'Gross profit (line 1c minus line 2)',                irs(inc), true);
    y = lineRow(pg, y, '4',  'Ordinary income (loss) from other partnerships',    '0');
    y = lineRow(pg, y, '5',  'Net farm profit (loss)',                             '0');
    y = lineRow(pg, y, '6',  'Net gain (loss) — Form 4797',                       '0');
    y = lineRow(pg, y, '7',  'Other income (loss)',                               '0');
    y = lineRow(pg, y, '8',  'Total income (loss) — add lines 3 through 7',       irs(inc), true);
    y -= 6;

    y = sectionBar(pg, y, 'DEDUCTIONS');
    if (advAmt > 0) y = lineRow(pg, y, '20', 'Advertising', irs(advAmt));
    Object.entries(cats).sort(([,a],[,b]) => b-a).slice(0,4).forEach(([cn, ca]) => {
      if (ca > 0 && !/advertis|marketing/i.test(cn))
        y = lineRow(pg, y, '', cn, irs(ca), false, 8);
    });
    y = lineRow(pg, y, '20', 'Other deductions (attach statement)',                irs(otherDed));
    y = lineRow(pg, y, '21', 'Total deductions — add lines 9 through 20',         irs(exp), true);
    y = lineRow(pg, y, '22', 'Ordinary business income (loss) — line 8 minus line 21', irs(netIncome), true);
    y -= 6;

    // K-1 summary table on page 1
    if (partners.length > 0) {
      y -= 4;
      y = sectionBar(pg, y, 'SCHEDULE K-1 SUMMARY — PARTNER ALLOCATIONS');
      box(pg, ML, y-2, IW, 14, LGRAY, null);
      t(pg, 'Partner Name', ML+4, y+2, 7.5, fontB, GRAY3);
      t(pg, 'Country', ML+220, y+2, 7.5, fontB, GRAY3);
      tR(pg, 'Ownership %', ML+350, y+2, 7.5, fontB, GRAY3);
      tR(pg, 'Allocated Income', W-MR-4, y+2, 7.5, fontB, GRAY3);
      partners.forEach((pt, i) => {
        y -= 16;
        if (i % 2 === 0) box(pg, ML, y-4, IW, 16, rgb(0.97,0.97,0.97), null);
        const pct = Number(pt.ownership_percent || pt.profit_percent || 0);
        t(pg, pt.name, ML+4, y, 8, font, BLACK);
        t(pg, pt.country || '', ML+220, y, 8, font, BLACK);
        tR(pg, `${pct}%`, ML+350, y, 8, fontB, BLACK);
        tR(pg, fmtUSD(netIncome * pct / 100), W-MR-4, y, 8, fontB, BLACK);
      });
      y -= 4;
    }

    await sigBlock(pg, y);

    // Individual K-1 pages (one per partner, appended to the same PDF)
    if (partners.length > 0) {
      const allPages = [pg];
      partners.forEach((pt, i) => {
        const k1pg = buildK1Page(pt, i + 2, totalPages, netIncome, fmtUSD);
        allPages.push(k1pg);
      });
      if (preview) stampPreview(allPages);
    } else {
      if (preview) stampPreview([pg]);
    }
  }

  // Builds one Schedule K-1 page and returns the page object
  function buildK1Page(pt, pageNum, totalPages, netIncome, fmtUSD) {
    const pg = pdfDoc.addPage([W, H]);
    const pct          = Number(pt.ownership_percent || pt.profit_percent || 0);
    const allocIncome  = netIncome * pct / 100;
    const partnerType  = pt.partner_type || 'general';
    const GREEN        = rgb(0.07, 0.53, 0.33);

    // Header
    box(pg, 0, H-34, W, 34, rgb(0.07,0.53,0.33), null);
    t(pg, 'Schedule', ML, H-23, 9, font, rgb(0.7,1,0.85));
    t(pg, 'K-1', ML+46, H-24, 13, fontB, WHITE);
    t(pg, `(Form 1065)  Partner's Share of Income, Deductions, Credits, etc.`, ML+70, H-23, 8, font, rgb(0.75,1,0.87));
    tR(pg, `Tax Year ${taxYear}  |  Page ${pageNum} of ${totalPages}`, W-MR, H-23, 7.5, font, rgb(0.7,0.9,0.8));
    hline(pg, H-34, 0, W, 0.5, GREEN);
    t(pg, 'Department of the Treasury - Internal Revenue Service', ML, H-44, 6.5, font, GRAY6);

    let y = H - 58;

    // Part I — Partnership info
    y = sectionBar(pg, y, 'PART I — INFORMATION ABOUT THE PARTNERSHIP');
    y -= 4;
    const P1H = 26;
    box(pg, ML, y - P1H*2, IW, P1H*2, LGRAY, null);
    box(pg, ML, y - P1H*2, IW, P1H*2, null, rgb(0.55,0.55,0.55));
    const DX = ML + IW * 0.55;
    vline(pg, DX, y-P1H*2, y, 0.5, rgb(0.55,0.55,0.55));
    hline(pg, y-P1H, ML, W-MR, 0.5, rgb(0.55,0.55,0.55));

    t(pg, 'A  Partnership EIN', ML+4, y-8, 6.5, font, GRAY6);
    t(pg, ein || '(not set)', ML+4, y-20, 8.5, fontB, BLACK);
    t(pg, 'B  Partnership name', DX+4, y-8, 6.5, font, GRAY6);
    t(pg, corpName || '(not set)', DX+4, y-20, 8.5, fontB, BLACK);

    t(pg, 'C  IRS Center', ML+4, y-P1H-8, 6.5, font, GRAY6);
    t(pg, 'Ogden, UT', ML+4, y-P1H-20, 8.5, font, BLACK);
    t(pg, 'D  Tax year', DX+4, y-P1H-8, 6.5, font, GRAY6);
    t(pg, `01/01/${taxYear} – 12/31/${taxYear}`, DX+4, y-P1H-20, 8.5, font, BLACK);

    y -= P1H*2 + 10;

    // Part II — Partner info
    y = sectionBar(pg, y, 'PART II — INFORMATION ABOUT THE PARTNER');
    y -= 4;
    const P2H = 26;
    box(pg, ML, y - P2H*3, IW, P2H*3, LGRAY, null);
    box(pg, ML, y - P2H*3, IW, P2H*3, null, rgb(0.55,0.55,0.55));
    hline(pg, y-P2H,   ML, W-MR, 0.5, rgb(0.55,0.55,0.55));
    hline(pg, y-P2H*2, ML, W-MR, 0.5, rgb(0.55,0.55,0.55));
    vline(pg, DX, y-P2H*2, y, 0.5, rgb(0.55,0.55,0.55));

    t(pg, 'E  Partner name', ML+4, y-8, 6.5, font, GRAY6);
    t(pg, pt.name || '(not set)', ML+4, y-20, 9, fontB, BLACK);

    t(pg, 'F  Partner address / country', ML+4, y-P2H-8, 6.5, font, GRAY6);
    t(pg, pt.address || pt.country || '(see attachment)', ML+4, y-P2H-20, 8.5, font, BLACK);
    t(pg, 'G  Partner TIN', DX+4, y-P2H-8, 6.5, font, GRAY6);
    t(pg, pt.tin || 'N/A', DX+4, y-P2H-20, 8.5, font, BLACK);

    t(pg, 'H  Partner type', ML+4, y-P2H*2-8, 6.5, font, GRAY6);
    t(pg, partnerType === 'limited' ? '[  ] General  [X] Limited' : '[X] General  [  ] Limited', ML+4, y-P2H*2-20, 8.5, font, BLACK);
    t(pg, 'I  Country of residence', DX+4, y-P2H*2-8, 6.5, font, GRAY6);
    t(pg, pt.country || '(not set)', DX+4, y-P2H*2-20, 8.5, font, BLACK);

    y -= P2H*3 + 10;

    // Part III — Allocations
    y = sectionBar(pg, y, 'PART III — PARTNER\'S SHARE OF CURRENT YEAR INCOME, DEDUCTIONS, CREDITS');
    y -= 4;

    // Profit/loss/capital percentages row
    box(pg, ML, y-20, IW, 20, rgb(0.97,0.97,0.97), null);
    box(pg, ML, y-20, IW, 20, null, rgb(0.55,0.55,0.55));
    const thirdW = IW / 3;
    vline(pg, ML+thirdW,   y-20, y, 0.5, rgb(0.55,0.55,0.55));
    vline(pg, ML+thirdW*2, y-20, y, 0.5, rgb(0.55,0.55,0.55));
    t(pg, 'Profit %', ML+4, y-8, 6.5, font, GRAY6);
    t(pg, `${pct}%`, ML+4, y-18, 8.5, fontB, BLACK);
    t(pg, 'Loss %', ML+thirdW+4, y-8, 6.5, font, GRAY6);
    t(pg, `${pct}%`, ML+thirdW+4, y-18, 8.5, fontB, BLACK);
    t(pg, 'Capital %', ML+thirdW*2+4, y-8, 6.5, font, GRAY6);
    t(pg, `${pct}%`, ML+thirdW*2+4, y-18, 8.5, fontB, BLACK);
    y -= 20; y -= 6;

    y = lineRow(pg, y, '1',  'Ordinary business income (loss)',                          fmtUSD(allocIncome), true);
    y = lineRow(pg, y, '2',  'Net rental real estate income (loss)',                     '0');
    y = lineRow(pg, y, '3',  'Other net rental income (loss)',                           '0');
    y = lineRow(pg, y, '4',  'Guaranteed payments for services',                         '0');
    y = lineRow(pg, y, '5',  'Interest income',                                          '0');
    y = lineRow(pg, y, '6',  'Ordinary dividends',                                       '0');
    y = lineRow(pg, y, '7',  'Royalties',                                                '0');
    y = lineRow(pg, y, '8',  'Net short-term capital gain (loss)',                       '0');
    y = lineRow(pg, y, '9',  'Net long-term capital gain (loss)',                        '0');
    y = lineRow(pg, y, '14', 'Self-employment earnings (loss)',                          fmtUSD(allocIncome));
    y -= 6;

    // Allocation summary box
    box(pg, ML, y-52, IW, 52, LGRAY, null);
    box(pg, ML, y-52, IW, 52, null, GREEN);
    t(pg, 'ALLOCATION SUMMARY', ML+4, y-10, 7.5, fontB, rgb(0.07,0.53,0.33));
    hline(pg, y-14, ML, W-MR, 0.5, GREEN);
    t(pg, 'Partnership net income:', ML+8, y-27, 8, font, BLACK);
    tR(pg, fmtUSD(netIncome), W-MR-8, y-27, 8.5, fontB, BLACK);
    t(pg, `Partner's ownership share:`, ML+8, y-40, 8, font, BLACK);
    tR(pg, `${pct}%`, W-MR-8, y-40, 8.5, fontB, BLACK);
    t(pg, `Partner's allocated income (Line 1):`, ML+8, y-51, 8, fontB, BLACK);
    tR(pg, fmtUSD(allocIncome), W-MR-8, y-51, 9, fontB, rgb(0.07,0.53,0.33));
    y -= 60;

    // Disclaimer
    y -= 4;
    box(pg, ML, y-32, IW, 32, rgb(1,0.97,0.91), null);
    box(pg, ML, y-32, IW, 32, null, rgb(0.85,0.65,0.2));
    t(pg, '(!)  PRO FORMA — INFORMATIONAL ONLY', ML+6, y-10, 7.5, fontB, rgb(0.5,0.3,0));
    t(pg, 'This Schedule K-1 is a pro forma document generated for informational purposes. The partner should use this', ML+6, y-21, 6.5, font, rgb(0.45,0.28,0));
    t(pg, 'document as a basis for reporting their share of partnership income. Consult a licensed CPA before filing.', ML+6, y-31, 6.5, font, rgb(0.45,0.28,0));

    return pg;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FORM 7004  (Automatic Extension of Time to File)
  // ══════════════════════════════════════════════════════════════════════════
  async function build7004() {
    const codeMap  = {'1065':'09','1120':'12','1120-S':'17','1120-F':'26','1041':'04'};
    const code     = codeMap[extendForm] || '12';
    const formName = {'09':'Form 1065','12':'Form 1120','17':'Form 1120-S','26':'Form 1120-F','04':'Form 1041'}[code] || 'Form 1120';

    const pg = pdfDoc.addPage([W, H]);
    pageHeader(pg, '7004', `Application for Automatic Extension of Time To File — ${formName}`, 1, 1);
    t(pg, `Tax year: January 1, ${taxYear} - December 31, ${taxYear}`, ML, H-47, 7, font, GRAY6);

    let y = H - 58;
    y = companyBlock(pg, y);
    y -= 8;

    y = sectionBar(pg, y, 'PART I — AUTOMATIC 6-MONTH EXTENSION OF TIME');
    box(pg, ML, y-28, IW, 28, LGRAY, null);
    box(pg, ML, y-28, IW, 28, null, rgb(0.55,0.55,0.55));
    t(pg, '1a  Enter the form code for the return for which you are requesting an extension:', ML+4, y-10, 7, font, GRAY6);
    t(pg, code,       ML+350, y-22, 14, fontB, BLACK);
    t(pg, `(${formName})`, ML+370, y-22, 8, font, GRAY3);
    y -= 28; y -= 8;

    y = sectionBar(pg, y, 'PART II — ALL FILERS MUST COMPLETE THIS PART');
    y = lineRow(pg, y, '3',  'Is the organization a corporation that is the common parent of a consolidated group?', '[ ] Yes  [X] No');
    y = lineRow(pg, y, '4',  'If "Yes," attach a schedule listing name, address, and EIN for each member', '');
    y = lineRow(pg, y, '5a', 'If the organization qualifies under Reg. sec.1.6081-5, check here >', '[ ]');
    y = lineRow(pg, y, '5b', 'If "Yes," is the organization\'s tax year a 52-53-week tax year?', '[ ] Yes  [ ] No');
    y = lineRow(pg, y, '6',  'Tentative total tax', '0');
    y = lineRow(pg, y, '7',  'Total payments and credits', '0');
    y = lineRow(pg, y, '8',  'Balance due — subtract line 7 from line 6. Deposit this amount using EFTPS.', '0', true);
    y -= 8;

    y = sectionBar(pg, y, 'SIGNATURE');
    y -= 8;
    box(pg, ML, y-70, IW, 70, LGRAY, null);
    box(pg, ML, y-70, IW, 70, null, BLACK);
    t(pg, 'Signature of authorized individual', ML+4, y-9, 6.5, font, GRAY6);
    hline(pg, y-26, ML+4,   ML+200, 0.7, BLACK);
    await drawSig(pg, ML+6, y-27, 192, 20);
    t(pg, 'Date',    ML+210, y-9,  6.5, font, GRAY6);
    t(pg, todayStr,  ML+213, y-25, 8.5, font, BLACK);
    hline(pg, y-26, ML+210, W-MR-4, 0.7, BLACK);
    t(pg, 'Title',   ML+4,   y-36, 6.5, font, GRAY6);
    t(pg, ownerTitle, ML+4,  y-49, 8.5, font, BLACK);
    hline(pg, y-52, ML+4,   ML+260, 0.7, BLACK);
    t(pg, 'Print / Type name', ML+270, y-36, 6.5, font, GRAY6);
    t(pg, ownerName, ML+270, y-49, 8.5, font, BLACK);
    hline(pg, y-52, ML+270, W-MR-4, 0.7, BLACK);

    if (preview) stampPreview([pg]);
  }

  // ── Route ──────────────────────────────────────────────────────────────────
  if (form_type === '7004') {
    await build7004();
  } else if (form_type === '1065') {
    await build1065();
  } else if (form_type === '1120') {
    await build1120();
  } else if (form_type === '5472') {
    await build5472();
  } else {
    // Default '5472_1120': 1120 pro forma first, then 5472 attachment
    await build1120();
    await build5472();
  }

  return pdfDoc.save();
}

/**
 * Generates individual Schedule K-1 PDFs — one per partner.
 * Returns an array of { partner_name, ownership_percent, allocated_income, pdf_bytes }.
 */
export async function generateK1Pdfs({ partners = [], company, financials = {}, transactions = [], tax_year, preview = false }) {
  if (!partners.length) return [];

  const INCOME_TYPES_SET  = new Set(['services_received', 'rent_received', 'royalties_received', 'loan_to_owner']);
  const EXPENSE_TYPES_SET = new Set(['services_paid', 'rent_paid', 'royalties_paid', 'loan_from_owner', 'capital_contribution', 'distribution']);

  let inc, exp;
  if (financials.gross_revenue != null) {
    inc = Number(financials.gross_revenue);
    exp = Object.values(financials.expenses || {}).reduce((s, v) => s + Number(v || 0), 0);
  } else {
    inc = transactions.filter(t => INCOME_TYPES_SET.has(t.type)).reduce((s, t) => s + Number(t.amount || 0), 0);
    exp = transactions.filter(t => EXPENSE_TYPES_SET.has(t.type)).reduce((s, t) => s + Number(t.amount || 0), 0);
  }
  const netIncome  = inc - exp;
  const fmtUSD     = n => `$${Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2})}`;
  const ein        = company.ein || '';
  const corpName   = company.name || '';
  const addr       = company.address || {};
  const street     = addr.street || '';
  const cityStateZip = [addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
  const taxYear    = tax_year;
  const todayStr   = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  const results = [];

  for (const pt of partners) {
    const doc   = await PDFDocument.create();
    const font  = await doc.embedFont(StandardFonts.Helvetica);
    const fontB = await doc.embedFont(StandardFonts.HelveticaBold);

    const W = 612, H = 792, ML = 48, MR = 48, IW = W - ML - MR;
    const BLACK = rgb(0,0,0), WHITE = rgb(1,1,1);
    const GRAY3 = rgb(0.3,0.3,0.3), GRAY6 = rgb(0.6,0.6,0.6);
    const LGRAY = rgb(0.93,0.93,0.93);
    const GREEN = rgb(0.07, 0.53, 0.33);

    const hline = (pg, y, x0=ML, x1=W-MR, w=0.4, c=rgb(0.7,0.7,0.7)) =>
      pg.drawLine({start:{x:x0,y},end:{x:x1,y},thickness:w,color:c});
    const vline = (pg, x, y0, y1, w=0.4, c=rgb(0.7,0.7,0.7)) =>
      pg.drawLine({start:{x,y:y0},end:{x,y:y1},thickness:w,color:c});
    const box = (pg, x, y, w, h, fill, stroke) => {
      if (fill)   pg.drawRectangle({x,y,width:w,height:h,color:fill});
      if (stroke) pg.drawRectangle({x,y,width:w,height:h,borderColor:stroke,borderWidth:0.5});
    };
    const t = (pg, s, x, y, sz=8.5, f=font, c=BLACK) => {
      if (s == null || s === '') return;
      pg.drawText(String(s), {x, y, size:sz, font:f, color:c});
    };
    const tR = (pg, s, rx, y, sz=8.5, f=font, c=BLACK) => {
      if (s == null || s === '') return;
      const str = String(s);
      pg.drawText(str, {x: rx - f.widthOfTextAtSize(str, sz), y, size:sz, font:f, color:c});
    };
    const lineRow = (pg, y, num, label, val, bold=false, indent=0) => {
      hline(pg, y, ML, W-MR);
      const f = bold ? fontB : font;
      if (num) t(pg, num, ML+3, y-11, 7.5, fontB, GRAY3);
      t(pg, label, ML+22+indent, y-11, 8, f, BLACK);
      if (val !== null && val !== undefined && val !== '') tR(pg, val, W-MR-4, y-11, 8.5, fontB, BLACK);
      return y - 15;
    };

    const pct         = Number(pt.ownership_percent || pt.profit_percent || 0);
    const allocIncome = netIncome * pct / 100;
    const partnerType = pt.partner_type || 'general';

    const pg = doc.addPage([W, H]);

    // Header
    box(pg, 0, H-34, W, 34, GREEN, null);
    t(pg, 'Schedule', ML, H-23, 9, font, rgb(0.7,1,0.85));
    t(pg, 'K-1', ML+46, H-24, 13, fontB, WHITE);
    t(pg, `(Form 1065)  Partner's Share of Income, Deductions, Credits, etc.`, ML+70, H-23, 8, font, rgb(0.75,1,0.87));
    tR(pg, `Tax Year ${taxYear}  |  Page 1 of 1`, W-MR, H-23, 7.5, font, rgb(0.7,0.9,0.8));
    hline(pg, H-34, 0, W, 0.5, GREEN);
    t(pg, 'Department of the Treasury - Internal Revenue Service', ML, H-44, 6.5, font, GRAY6);

    let y = H - 58;

    // Part I
    y -= 0;
    box(pg, 0, y-13, W, 13, rgb(0.18,0.18,0.18), null);
    t(pg, 'PART I — INFORMATION ABOUT THE PARTNERSHIP', ML+4, y-10, 7.5, fontB, WHITE);
    y -= 13; y -= 4;

    const P1H = 26;
    const DX  = ML + IW * 0.55;
    box(pg, ML, y-P1H*2, IW, P1H*2, LGRAY, null);
    box(pg, ML, y-P1H*2, IW, P1H*2, null, rgb(0.55,0.55,0.55));
    vline(pg, DX, y-P1H*2, y, 0.5, rgb(0.55,0.55,0.55));
    hline(pg, y-P1H, ML, W-MR, 0.5, rgb(0.55,0.55,0.55));

    t(pg, 'A  Partnership EIN', ML+4, y-8, 6.5, font, GRAY6);
    t(pg, ein || '(not set)', ML+4, y-20, 8.5, fontB, BLACK);
    t(pg, 'B  Partnership name', DX+4, y-8, 6.5, font, GRAY6);
    t(pg, corpName || '(not set)', DX+4, y-20, 8.5, fontB, BLACK);
    t(pg, 'C  IRS Center', ML+4, y-P1H-8, 6.5, font, GRAY6);
    t(pg, 'Ogden, UT', ML+4, y-P1H-20, 8.5, font, BLACK);
    t(pg, 'D  Tax year', DX+4, y-P1H-8, 6.5, font, GRAY6);
    t(pg, `01/01/${taxYear} – 12/31/${taxYear}`, DX+4, y-P1H-20, 8.5, font, BLACK);

    y -= P1H*2 + 10;

    // Part II
    box(pg, 0, y-13, W, 13, rgb(0.18,0.18,0.18), null);
    t(pg, 'PART II — INFORMATION ABOUT THE PARTNER', ML+4, y-10, 7.5, fontB, WHITE);
    y -= 13; y -= 4;

    const P2H = 26;
    box(pg, ML, y-P2H*3, IW, P2H*3, LGRAY, null);
    box(pg, ML, y-P2H*3, IW, P2H*3, null, rgb(0.55,0.55,0.55));
    hline(pg, y-P2H,   ML, W-MR, 0.5, rgb(0.55,0.55,0.55));
    hline(pg, y-P2H*2, ML, W-MR, 0.5, rgb(0.55,0.55,0.55));
    vline(pg, DX, y-P2H*2, y, 0.5, rgb(0.55,0.55,0.55));

    t(pg, 'E  Partner name', ML+4, y-8, 6.5, font, GRAY6);
    t(pg, pt.name || '(not set)', ML+4, y-20, 9, fontB, BLACK);
    t(pg, 'F  Partner address / country', ML+4, y-P2H-8, 6.5, font, GRAY6);
    t(pg, pt.address || pt.country || '(see attachment)', ML+4, y-P2H-20, 8.5, font, BLACK);
    t(pg, 'G  Partner TIN', DX+4, y-P2H-8, 6.5, font, GRAY6);
    t(pg, pt.tin || 'N/A', DX+4, y-P2H-20, 8.5, font, BLACK);
    t(pg, 'H  Partner type', ML+4, y-P2H*2-8, 6.5, font, GRAY6);
    t(pg, partnerType === 'limited' ? '[  ] General  [X] Limited' : '[X] General  [  ] Limited', ML+4, y-P2H*2-20, 8.5, font, BLACK);
    t(pg, 'I  Country of residence', DX+4, y-P2H*2-8, 6.5, font, GRAY6);
    t(pg, pt.country || '(not set)', DX+4, y-P2H*2-20, 8.5, font, BLACK);

    y -= P2H*3 + 10;

    // Part III
    box(pg, 0, y-13, W, 13, rgb(0.18,0.18,0.18), null);
    t(pg, 'PART III — PARTNER\'S SHARE OF CURRENT YEAR INCOME, DEDUCTIONS, CREDITS', ML+4, y-10, 7.5, fontB, WHITE);
    y -= 13; y -= 4;

    const thirdW = IW / 3;
    box(pg, ML, y-20, IW, 20, rgb(0.97,0.97,0.97), null);
    box(pg, ML, y-20, IW, 20, null, rgb(0.55,0.55,0.55));
    vline(pg, ML+thirdW,   y-20, y, 0.5, rgb(0.55,0.55,0.55));
    vline(pg, ML+thirdW*2, y-20, y, 0.5, rgb(0.55,0.55,0.55));
    t(pg, 'Profit %', ML+4, y-8, 6.5, font, GRAY6);           t(pg, `${pct}%`, ML+4, y-18, 8.5, fontB, BLACK);
    t(pg, 'Loss %', ML+thirdW+4, y-8, 6.5, font, GRAY6);       t(pg, `${pct}%`, ML+thirdW+4, y-18, 8.5, fontB, BLACK);
    t(pg, 'Capital %', ML+thirdW*2+4, y-8, 6.5, font, GRAY6);  t(pg, `${pct}%`, ML+thirdW*2+4, y-18, 8.5, fontB, BLACK);
    y -= 20; y -= 6;

    y = lineRow(pg, y, '1',  'Ordinary business income (loss)',           fmtUSD(allocIncome), true);
    y = lineRow(pg, y, '2',  'Net rental real estate income (loss)',      '0');
    y = lineRow(pg, y, '3',  'Other net rental income (loss)',            '0');
    y = lineRow(pg, y, '4',  'Guaranteed payments for services',          '0');
    y = lineRow(pg, y, '5',  'Interest income',                           '0');
    y = lineRow(pg, y, '6',  'Ordinary dividends',                        '0');
    y = lineRow(pg, y, '7',  'Royalties',                                 '0');
    y = lineRow(pg, y, '8',  'Net short-term capital gain (loss)',         '0');
    y = lineRow(pg, y, '9',  'Net long-term capital gain (loss)',          '0');
    y = lineRow(pg, y, '14', 'Self-employment earnings (loss)',            fmtUSD(allocIncome));
    y -= 6;

    // Allocation summary
    box(pg, ML, y-52, IW, 52, LGRAY, null);
    box(pg, ML, y-52, IW, 52, null, GREEN);
    t(pg, 'ALLOCATION SUMMARY', ML+4, y-10, 7.5, fontB, GREEN);
    hline(pg, y-14, ML, W-MR, 0.5, GREEN);
    t(pg, 'Partnership net income:', ML+8, y-27, 8, font, BLACK);
    tR(pg, fmtUSD(netIncome), W-MR-8, y-27, 8.5, fontB, BLACK);
    t(pg, `Partner's ownership share:`, ML+8, y-40, 8, font, BLACK);
    tR(pg, `${pct}%`, W-MR-8, y-40, 8.5, fontB, BLACK);
    t(pg, `Partner's allocated income (Line 1):`, ML+8, y-51, 8, fontB, BLACK);
    tR(pg, fmtUSD(allocIncome), W-MR-8, y-51, 9, fontB, GREEN);
    y -= 60;

    // Disclaimer
    y -= 4;
    box(pg, ML, y-32, IW, 32, rgb(1,0.97,0.91), null);
    box(pg, ML, y-32, IW, 32, null, rgb(0.85,0.65,0.2));
    t(pg, '(!)  PRO FORMA — INFORMATIONAL ONLY', ML+6, y-10, 7.5, fontB, rgb(0.5,0.3,0));
    t(pg, 'This Schedule K-1 is a pro forma document generated for informational purposes. The partner should use this', ML+6, y-21, 6.5, font, rgb(0.45,0.28,0));
    t(pg, 'document as a basis for reporting their share of partnership income. Consult a licensed CPA before filing.', ML+6, y-31, 6.5, font, rgb(0.45,0.28,0));

    if (preview) {
      pg.drawText('UNSIGNED PREVIEW', {
        x:60, y:320, size:56, font:fontB,
        color:rgb(0.87,0.87,0.87), opacity:0.22,
        rotate:{type:'degrees',angle:45},
      });
    }

    const pdfBytes = await doc.save();
    results.push({
      partner_name:      pt.name,
      ownership_percent: pct,
      allocated_income:  Math.round(allocIncome * 100) / 100,
      pdf_bytes:         pdfBytes,
    });
  }

  return results;
}
