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

export default async function handler(req, res) {
  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  if (req.method === 'GET') {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });
    const { data, error } = await sb.from('partner_users').select('user_id, external_id, created_at').eq('partner_id', partner.partner_id).eq('user_id', user_id).single();
    if (error || !data) return res.status(404).json({ error: 'User not found.' });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { email, name, external_id } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Missing required field: email.' });
    const normalizedEmail = email.trim().toLowerCase();

    const { data: existing } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('email', normalizedEmail).maybeSingle();

    if (existing) {
      const { data: linkData } = await sb.auth.admin.generateLink({ type: 'magiclink', email: normalizedEmail });
      return res.status(200).json({ user_id: existing.user_id, email: normalizedEmail, token: linkData?.properties?.hashed_token || null, created: false });
    }

    const { data: newUser, error: createError } = await sb.auth.admin.createUser({
      email: normalizedEmail, email_confirm: true,
      user_metadata: { full_name: name || '', partner_id: partner.partner_id },
    });
    if (createError || !newUser?.user) return res.status(500).json({ error: createError?.message || 'Failed to create user.' });

    const userId = newUser.user.id;
    await sb.from('partner_users').insert({ partner_id: partner.partner_id, user_id: userId, email: normalizedEmail, external_id: external_id || null });

    const { data: linkData } = await sb.auth.admin.generateLink({ type: 'magiclink', email: normalizedEmail });
    return res.status(201).json({ user_id: userId, email: normalizedEmail, token: linkData?.properties?.hashed_token || null, created: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
