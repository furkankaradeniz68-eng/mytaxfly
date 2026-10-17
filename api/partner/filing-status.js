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

// GET /api/partner/filing-status?external_id=...&form_type=...&tax_year=...
// Returns status of one or all filings for the given external_id.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const { external_id, form_type, tax_year, filing_id } = req.query;

  // ── Look up by filing_id (most specific) ─────────────────────────────────
  if (filing_id) {
    const { data, error } = await sb
      .from('filings')
      .select('id, external_id, form_type, tax_year, company_name, company_ein, status, fax_id, pdf_path, signer_name, signer_title, created_at, updated_at')
      .eq('id', filing_id)
      .eq('partner_id', partner.partner_id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Filing not found.' });

    return res.status(200).json(formatFiling(data));
  }

  // ── Require external_id for all other lookups ─────────────────────────────
  if (!external_id) {
    return res.status(400).json({
      error: 'Provide external_id (and optionally form_type, tax_year) or filing_id.',
    });
  }

  let query = sb
    .from('filings')
    .select('id, external_id, form_type, tax_year, company_name, company_ein, status, fax_id, pdf_path, signer_name, signer_title, created_at, updated_at')
    .eq('partner_id', partner.partner_id)
    .eq('external_id', external_id)
    .order('created_at', { ascending: false });

  if (form_type) query = query.eq('form_type', form_type);
  if (tax_year)  query = query.eq('tax_year', Number(tax_year));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  if (!data || data.length === 0) {
    return res.status(404).json({
      error: 'No filings found for this external_id.',
      external_id,
    });
  }

  // If exactly one result (form_type + tax_year were both provided), return it flat.
  if (data.length === 1 && form_type && tax_year) {
    return res.status(200).json(formatFiling(data[0]));
  }

  return res.status(200).json({ filings: data.map(formatFiling) });
}

function formatFiling(row) {
  const STATUS_MESSAGE = {
    submitted: 'Einreichung gespeichert. Versand ausstehend.',
    mailed:    'Brief per USPS Certified Mail ans IRS versendet.',
    faxed:     'Brief per USPS Certified Mail ans IRS versendet.',
    accepted:  'IRS hat die Einreichung akzeptiert.',
    rejected:  'IRS hat die Einreichung abgelehnt. Support kontaktieren.',
    pending:   'Wird verarbeitet.',
  };

  return {
    filing_id:    row.id,
    external_id:  row.external_id,
    form_type:    row.form_type,
    tax_year:     row.tax_year,
    company_name: row.company_name,
    company_ein:  row.company_ein,
    status:       row.status,
    status_message: STATUS_MESSAGE[row.status] ?? row.status,
    letter_id:    row.fax_id ?? null,
    signer_name:  row.signer_name ?? null,
    signer_title: row.signer_title ?? null,
    submitted_at: row.created_at,
    updated_at:   row.updated_at,
  };
}
