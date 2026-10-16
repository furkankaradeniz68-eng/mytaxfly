import { requirePartnerAuth } from './_auth.js';

// GET  /api/partner/settings  — return partner settings
// PATCH /api/partner/settings — update webhook_url
export default async function handler(req, res) {
  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  if (req.method === 'GET') {
    return res.status(200).json({
      partner_id:  partner.partner_id,
      webhook_url: partner.webhook_url ?? null,
      created_at:  partner.created_at,
    });
  }

  if (req.method === 'PATCH') {
    const { webhook_url } = req.body || {};
    if (webhook_url !== undefined && webhook_url !== null) {
      try { new URL(webhook_url); } catch {
        return res.status(400).json({ error: 'Invalid webhook_url — must be a valid URL.' });
      }
    }

    const { error } = await sb
      .from('partner_api_keys')
      .update({ webhook_url: webhook_url ?? null })
      .eq('key', partner.key);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, webhook_url: webhook_url ?? null });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
