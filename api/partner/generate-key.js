import { randomBytes } from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const { partner_name, partner_id } = req.body || {};
  if (!partner_name || !partner_id) {
    return res.status(400).json({ error: 'Missing partner_name or partner_id.' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const key = 'mtf_live_' + randomBytes(24).toString('hex');

  const { data, error } = await sb.from('partner_api_keys').insert({
    key, partner_name, partner_id, active: true,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json({
    api_key: key,
    partner_name,
    partner_id,
    created_at: data.created_at,
    note: 'Store this key securely — it will not be shown again.',
  });
}
