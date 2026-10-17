import { readFileSync } from 'fs';
import path from 'path';

async function requirePartnerAuth(req, res) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !apiKey.startsWith('mtf_live_')) {
    res.status(401).json({ error: 'Missing or invalid API key. Pass X-API-Key: mtf_live_...' });
    return null;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: partner, error } = await sb
    .from('partner_api_keys').select('*').eq('key', apiKey).eq('active', true).single();
  if (error || !partner) { res.status(401).json({ error: 'Invalid or revoked API key.' }); return null; }
  return { partner, sb };
}

// POST /api/partner/submit-filing
// Generates the PDF, embeds the e-signature block, stores it, and faxes to the IRS.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const {
    external_id, form_type, tax_year,
    company, foreign_owner, transactions = [],
    partners = [], financials = {},
    signer_name, signer_title, ip_address,
    extend_form = '1120', signature_png_base64 = null,
    signed_pdf_base64 = null, // pre-signed PDF upload — skips generation & e-sig overlay
    test = false,             // true → use LOB_TEST_KEY, mark filing as test
  } = req.body || {};

  // ── Validation ────────────────────────────────────────────────────────────
  const VALID_FORM_TYPES = ['5472_1120', '1065', '1120', '5472', '7004'];
  if (!external_id) return res.status(400).json({ error: 'Missing external_id.' });
  if (!form_type || !VALID_FORM_TYPES.includes(form_type))
    return res.status(400).json({ error: `form_type must be one of: ${VALID_FORM_TYPES.join(', ')}.` });
  if (!tax_year || typeof tax_year !== 'number')
    return res.status(400).json({ error: 'Missing tax_year (number).' });
  if (!company?.name || !company?.ein)
    return res.status(400).json({ error: 'Missing company.name or company.ein.' });
  if (!company?.address?.street || !company?.address?.city || !company?.address?.state || !company?.address?.zip)
    return res.status(400).json({ error: 'Missing company.address fields (street, city, state, zip). Must be the US registered agent address — required for USPS mailing.' });
  if (form_type === '5472_1120' && (!foreign_owner?.name || !foreign_owner?.country))
    return res.status(400).json({ error: 'Missing foreign_owner.name or foreign_owner.country.' });
  if (form_type === '1065' && !partners?.length)
    return res.status(400).json({ error: 'Missing partners array for form_type 1065.' });
  if (!signer_name) return res.status(400).json({ error: 'Missing signer_name.' });
  if (!signer_title) return res.status(400).json({ error: 'Missing signer_title.' });

  // ── Duplicate check ───────────────────────────────────────────────────────
  const { data: existing } = await sb
    .from('filings')
    .select('id, status')
    .eq('partner_id', partner.partner_id)
    .eq('external_id', external_id)
    .eq('form_type', form_type)
    .eq('tax_year', tax_year)
    .in('status', ['submitted', 'mailed', 'faxed', 'accepted'])
    .maybeSingle();

  if (existing) {
    return res.status(409).json({
      error: 'A filing for this external_id / form_type / tax_year has already been submitted.',
      filing_id: existing.id,
      status: existing.status,
    });
  }

  // ── PDF: use uploaded signed PDF or generate from form data ──────────────
  let pdfBytes;
  if (signed_pdf_base64) {
    try {
      pdfBytes = Buffer.from(signed_pdf_base64, 'base64');
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signed_pdf_base64: not valid base64.' });
    }
  } else {
    try {
      const { generatePdf } = await import('./_generate-pdf.js');
      pdfBytes = await generatePdf({ form_type, company, foreign_owner, transactions, partners, financials, tax_year, extend_form, signature_png_base64 });
    } catch (err) {
      console.error('PDF generation error:', err);
      return res.status(500).json({ error: 'PDF generation failed: ' + err.message });
    }

    try {
      pdfBytes = await embedSignature(pdfBytes, {
        signer_name, signer_title, ip_address,
        signed_at: new Date().toISOString(),
        form_type, tax_year,
      });
    } catch (err) {
      console.error('Signature embed error:', err);
      return res.status(500).json({ error: 'Signature embedding failed: ' + err.message });
    }
  }

  // ── Store in Supabase Storage ─────────────────────────────────────────────
  const timestamp = Date.now();
  const filename = `${partner.partner_id}/${external_id}/${tax_year}_${form_type}_${signed_pdf_base64 ? 'uploaded' : 'signed'}_${timestamp}.pdf`;

  const { error: upErr } = await sb.storage.from('filings').upload(
    filename, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: false }
  );
  if (upErr) {
    console.error('Storage upload error:', upErr.message);
    return res.status(500).json({ error: 'Failed to store signed PDF: ' + upErr.message });
  }

  const { data: signedData } = await sb.storage.from('filings').createSignedUrl(filename, 7 * 86400);

  // ── Insert filing record ──────────────────────────────────────────────────
  const { data: filing, error: dbErr } = await sb
    .from('filings')
    .insert({
      partner_id:   partner.partner_id,
      external_id,
      form_type,
      tax_year,
      company_name: company.name,
      company_ein:  company.ein,
      signer_name,
      signer_title,
      signer_ip:    ip_address || null,
      pdf_path:     filename,
      status:       'submitted',
      is_test:      test === true,
    })
    .select('id')
    .single();

  if (dbErr) {
    console.error('DB insert error:', dbErr.message);
    return res.status(500).json({ error: 'Failed to record filing: ' + dbErr.message });
  }

  // ── Mail to IRS via Lob ───────────────────────────────────────────────────
  // IRS mailing addresses — verified against IRS instructions (Dec 2024)
  //
  // 5472+1120 (Foreign-Owned DE): PIN Unit per Form 5472 Instructions (12/2024).
  //   Write "Foreign Owned U.S. DE" across top of 1120. Fax alt: 855-887-7737.
  //   Source: irs.gov/instructions/i5472 — NOT the general 1120 P.O. Box address.
  //
  // 1120 (C-Corp, no 5472): Ogden P.O. Box for all corporations.
  //
  // 1065 (Partnership): Ogden UT 84201-0011 for international/foreign partnerships.
  //   Hartford CT address is outdated and no longer valid.
  //   Source: irs.gov "Where to File Form 1065"
  //
  // 7004 (Extension): Same address as the main form being extended.
  const IRS_ADDRESS = {
    '5472_1120': { name: 'Internal Revenue Service', address_line1: '1973 Rulon White Blvd', address_line2: 'M/S 6112 Attn: PIN Unit', address_city: 'Ogden', address_state: 'UT', address_zip: '84201' },
    '5472':      { name: 'Internal Revenue Service', address_line1: '1973 Rulon White Blvd', address_line2: 'M/S 6112 Attn: PIN Unit', address_city: 'Ogden', address_state: 'UT', address_zip: '84201' },
    '1120':      { name: 'Internal Revenue Service', address_line1: 'P.O. Box 409101',        address_city: 'Ogden',    address_state: 'UT', address_zip: '84409' },
    '1065':      { name: 'Internal Revenue Service', address_line1: 'P.O. Box 409101',        address_city: 'Ogden',    address_state: 'UT', address_zip: '84409' },
    '7004':      { name: 'Internal Revenue Service', address_line1: 'P.O. Box 409101',        address_city: 'Ogden',    address_state: 'UT', address_zip: '84409' },
  };

  let lobResult  = null;
  let mailStatus = 'pending';

  const lobApiKey = (test && process.env.LOB_TEST_KEY)
    ? process.env.LOB_TEST_KEY
    : process.env.LOB_API_KEY;

  if (lobApiKey) {
    try {
      lobResult = await sendMailLob({
        pdfBytes,
        toAddress:   IRS_ADDRESS[form_type],
        fromAddress: {
          name:          company.name,
          address_line1: company.address?.street || '—',
          address_city:  company.address?.city   || '—',
          address_state: company.address?.state  || '—',
          address_zip:   company.address?.zip    || '00000',
        },
        description: `${form_type} Tax Year ${tax_year} — EIN ${company.ein}`,
        apiKey: lobApiKey,
      });
      mailStatus = 'mailed';
    } catch (err) {
      console.error('Lob mail error (non-fatal):', err.message);
    }
  }

  await sb.from('filings')
    .update({ fax_id: lobResult?.id ?? null, status: mailStatus })
    .eq('id', filing.id);

  // ── Fire webhook ──────────────────────────────────────────────────────────
  if (partner.webhook_url) {
    const { fireWebhook } = await import('./_webhook.js');
    await fireWebhook(sb, {
      partnerId:  partner.partner_id,
      webhookUrl: partner.webhook_url,
      event:      mailStatus === 'mailed' ? 'filing.mailed' : 'filing.submitted',
      payload: {
        filing_id:       filing.id,
        external_id,
        form_type,
        tax_year,
        status:          mailStatus,
        letter_id:       lobResult?.id      ?? null,
        tracking_number: lobResult?.tracking ?? null,
      },
    });
  }

  return res.status(201).json({
    filing_id:         filing.id,
    status:            mailStatus,
    is_test:           test === true,
    letter_id:         lobResult?.id         ?? null,
    tracking_number:   lobResult?.tracking   ?? null,
    expected_delivery: lobResult?.expected_delivery ?? null,
    pdf_url:    signedData?.signedUrl ?? null,
    expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    form_type,
    tax_year,
    external_id,
    message: mailStatus === 'mailed'
      ? `Form ${form_type} mailed to IRS via USPS Certified Mail (letter_id: ${lobResult?.id}). Tracking: ${lobResult?.tracking ?? 'pending'}.`
      : 'Filing stored. LOB_API_KEY not configured — mail not sent.',
  });
}

// ── Embed e-signature block on the last page ──────────────────────────────────
async function embedSignature(pdfBytes, { signer_name, signer_title, ip_address, signed_at, form_type, tax_year }) {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  const lastPage = pages[pages.length - 1];
  const { width } = lastPage.getSize();

  const font     = await doc.embedFont(StandardFonts.Helvetica);
  const bold     = await doc.embedFont(StandardFonts.HelveticaBold);
  const gray     = rgb(0.5, 0.5, 0.5);
  const black    = rgb(0, 0, 0);
  const lineGray = rgb(0.7, 0.7, 0.7);

  const boxY  = 60;
  const boxH  = 55;
  const padX  = 36;

  // Signature box border
  lastPage.drawRectangle({
    x: padX, y: boxY, width: width - 2 * padX, height: boxH,
    borderColor: lineGray, borderWidth: 0.5,
  });

  // Header
  lastPage.drawText('Electronic Signature — Filed under penalties of perjury', {
    x: padX + 6, y: boxY + boxH - 11, size: 7, font: bold, color: gray,
  });

  // Signer name (bold) + title
  lastPage.drawText(signer_name, {
    x: padX + 6, y: boxY + boxH - 24, size: 9, font: bold, color: black,
  });
  if (signer_title) {
    lastPage.drawText(signer_title, {
      x: padX + 6, y: boxY + boxH - 35, size: 8, font, color: black,
    });
  }

  // Timestamp + IP
  const dateStr = new Date(signed_at).toUTCString();
  lastPage.drawText(`Signed: ${dateStr}${ip_address ? `  |  IP: ${ip_address}` : ''}`, {
    x: padX + 6, y: boxY + boxH - 47, size: 7, font, color: gray,
  });

  // Legal note (right-aligned area)
  lastPage.drawText(
    `${form_type.replace('_', '+')} · Tax Year ${tax_year} · mytaxfly.com`,
    { x: width - padX - 180, y: boxY + 5, size: 6, font, color: gray }
  );

  return doc.save();
}

// ── Send physical mail via Lob REST API ──────────────────────────────────────
async function sendMailLob({ pdfBytes, toAddress, fromAddress, description, apiKey }) {
  const auth    = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  const pdfBlob = new Blob([Buffer.from(pdfBytes)], { type: 'application/pdf' });

  const form = new FormData();

  // Recipient (IRS)
  form.append('to[name]',             toAddress.name);
  form.append('to[address_line1]',    toAddress.address_line1);
  if (toAddress.address_line2) form.append('to[address_line2]', toAddress.address_line2);
  form.append('to[address_city]',     toAddress.address_city);
  form.append('to[address_state]',    toAddress.address_state);
  form.append('to[address_zip]',      toAddress.address_zip);
  form.append('to[address_country]',  'US');

  // Sender (LLC)
  form.append('from[name]',            fromAddress.name);
  form.append('from[address_line1]',   fromAddress.address_line1);
  form.append('from[address_city]',    fromAddress.address_city);
  form.append('from[address_state]',   fromAddress.address_state);
  form.append('from[address_zip]',     fromAddress.address_zip);
  form.append('from[address_country]', 'US');

  form.append('color',          'false');
  form.append('double_sided',   'true');
  form.append('extra_service',  'certified'); // USPS Certified Mail + tracking
  form.append('use_type',       'operational');
  form.append('description',    description);
  form.append('file',           pdfBlob, `${description.replace(/\s+/g, '_')}.pdf`);

  const resp = await fetch('https://api.lob.com/v1/letters', {
    method: 'POST', headers: { Authorization: auth }, body: form,
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error?.message || `Lob error ${resp.status}`);

  return { id: json.id, tracking: json.tracking_number || null, expected_delivery: json.expected_delivery_date || null };
}
