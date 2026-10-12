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
  } = req.body || {};

  if (!external_id) return res.status(400).json({ error: 'Missing external_id.' });
  if (!form_type || !['5472_1120', '1065'].includes(form_type))
    return res.status(400).json({ error: 'form_type must be "5472_1120" or "1065".' });
  if (!tax_year || typeof tax_year !== 'number')
    return res.status(400).json({ error: 'Missing tax_year (number).' });
  if (!company?.name || !company?.ein)
    return res.status(400).json({ error: 'Missing company.name or company.ein.' });
  if (!company?.address?.city || !company?.address?.state)
    return res.status(400).json({ error: 'Missing company.address fields (city, state).' });
  if (form_type === '5472_1120' && (!foreign_owner?.name || !foreign_owner?.country))
    return res.status(400).json({ error: 'Missing foreign_owner.name or foreign_owner.country.' });
  if (form_type === '1065' && !partners?.length)
    return res.status(400).json({ error: 'Missing partners array for form_type 1065.' });

  let pdfBytes;
  try {
    const { generatePdf } = await import('./_generate-pdf.js');
    pdfBytes = await generatePdf({ form_type, company, foreign_owner, transactions, partners, financials, tax_year, preview: true });
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

  return res.status(200).json({
    pdf_url: signedData.signedUrl,
    expires_at: expiresAt,
    form_type,
    tax_year,
    external_id,
  });
}


