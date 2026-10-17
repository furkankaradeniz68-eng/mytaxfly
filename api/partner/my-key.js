// GET /api/partner/my-key
// Validates a Supabase JWT and returns the partner's API key.
// Used by the dashboard after Supabase Auth login — the key stays in memory, never in localStorage.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Bearer token.' });
  const jwt = auth.slice(7);

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verify JWT and get user
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired token.' });

  // Look up partner API key linked to this Supabase user
  const { data: partner, error } = await sb
    .from('partner_api_keys')
    .select('key, partner_id, webhook_url, created_at')
    .eq('supabase_user_id', user.id)
    .eq('active', true)
    .single();

  if (error || !partner) return res.status(404).json({ error: 'No active partner API key found for this account.' });

  return res.status(200).json({
    api_key:     partner.key,
    partner_id:  partner.partner_id,
    webhook_url: partner.webhook_url ?? null,
    created_at:  partner.created_at,
  });
}
