import { requirePartnerAuth } from './_auth.js';

// GET /api/partner/webhook-logs
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const { data, error } = await sb
    .from('webhook_deliveries')
    .select('id, event, url, status_code, success, response_body, created_at')
    .eq('partner_id', partner.partner_id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ deliveries: data });
}
