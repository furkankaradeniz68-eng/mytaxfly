import { requirePartnerAuth } from './_auth.js';

// GET /api/partner/filings
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const { data, error } = await sb
    .from('filings')
    .select('id, external_id, form_type, tax_year, company_name, company_ein, signer_name, status, fax_id, created_at')
    .eq('partner_id', partner.partner_id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ filings: data });
}
