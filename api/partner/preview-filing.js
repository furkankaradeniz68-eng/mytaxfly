async function requirePartnerAuth(req, res) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !apiKey.startsWith('mtf_live_')) {
    res.status(401).json({ error: 'Missing or invalid API key. Pass X-API-Key: mtf_live_...' });
    return null;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: partner, error } = await sb.from('partner_api_keys').select('*').eq('key', apiKey).eq('active', true).single();
  if (error || !partner) { res.status(401).json({ error: 'Invalid or revoked API key.' }); return null; }
  return { partner, sb };
}

// POST /api/partner/preview-filing
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const {
    external_id, form_type, tax_year,
    company, foreign_owner, transactions = [],
    partners = [], financials = {},
    extend_form: extend_form_raw = null, signature_png_base64 = null,
  } = req.body || {};

  // Auto-detect extension form: 1065 filers must use Code 09, not Code 12 (1120)
  const extend_form = extend_form_raw || (form_type === '1065' ? '1065' : '1120');

  const VALID_FORM_TYPES = ['5472_1120', '1065', '1120', '5472', '7004'];
  if (!external_id) return res.status(400).json({ error: 'Missing external_id.' });
  if (!form_type || !VALID_FORM_TYPES.includes(form_type))
    return res.status(400).json({ error: `form_type must be one of: ${VALID_FORM_TYPES.join(', ')}.` });
  if (!tax_year || typeof tax_year !== 'number')
    return res.status(400).json({ error: 'Missing tax_year (number).' });
  if (!company?.name || !company?.ein)
    return res.status(400).json({ error: 'Missing company.name or company.ein.' });
  if (!company?.address?.street || !company?.address?.city || !company?.address?.state || !company?.address?.zip)
    return res.status(400).json({ error: 'Missing company.address fields (street, city, state, zip). Must be the US registered agent address.' });
  if (form_type === '5472_1120' && (!foreign_owner?.name || !foreign_owner?.country))
    return res.status(400).json({ error: 'Missing foreign_owner.name or foreign_owner.country.' });
  if (form_type === '1065' && !partners?.length)
    return res.status(400).json({ error: 'Missing partners array for form_type 1065.' });

  let pdfBytes;
  try {
    const { generatePdf } = await import('./_generate-pdf.js');
    pdfBytes = await generatePdf({ form_type, company, foreign_owner, transactions, partners, financials, tax_year, preview: false, extend_form, signature_png_base64 });
  } catch (err) {
    console.error('PDF generation error:', err);
    return res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }

  const filename = `${partner.partner_id}/${external_id}/${tax_year}_${form_type}_preview_${Date.now()}.pdf`;
  const { error: upErr } = await sb.storage.from('filings').upload(filename, Buffer.from(pdfBytes), {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (upErr) {
    console.error('Storage upload error:', upErr.message);
    return res.status(500).json({ error: 'Failed to store PDF: ' + upErr.message });
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: signedData, error: signErr } = await sb.storage.from('filings').createSignedUrl(filename, 86400);
  if (signErr) return res.status(500).json({ error: 'Failed to generate PDF URL.' });

  // Generate individual K-1 PDFs for partnerships
  let k1_pdfs = [];
  if (form_type === '1065' && partners.length > 0) {
    try {
      const { generateK1Pdfs } = await import('./_generate-pdf.js');
      const k1Results = await generateK1Pdfs({ partners, company, financials, transactions, tax_year, preview: true });
      k1_pdfs = k1Results.map(k1 => ({
        partner_name:      k1.partner_name,
        ownership_percent: k1.ownership_percent,
        allocated_income:  k1.allocated_income,
        pdf_base64:        Buffer.from(k1.pdf_bytes).toString('base64'),
      }));
    } catch (err) {
      console.error('K-1 preview generation error (non-fatal):', err.message);
    }
  }

  return res.status(200).json({
    pdf_url:    signedData.signedUrl,
    pdf_base64: Buffer.from(pdfBytes).toString('base64'),
    expires_at: expiresAt,
    form_type,
    tax_year,
    external_id,
    k1_pdfs,
  });
}


