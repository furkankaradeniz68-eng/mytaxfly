async function requirePartnerAuth(req, res) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !apiKey.startsWith('mtf_live_')) {
    res.status(401).json({ error: 'Missing or invalid API key.' });
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

  async function verifyUser(userId) {
    const { data } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('user_id', userId).maybeSingle();
    return !!data;
  }

  // GET — list clients for a user
  if (req.method === 'GET') {
    const { user_id, client_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    if (client_id) {
      const { data, error } = await sb.from('partner_clients').select('*').eq('id', client_id).eq('user_id', user_id).single();
      if (error || !data) return res.status(404).json({ error: 'Client not found.' });
      return res.status(200).json(data);
    }

    const { data, error } = await sb.from('partner_clients').select('*').eq('user_id', user_id).order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ clients: data });
  }

  // POST — create client
  if (req.method === 'POST') {
    const { user_id, name, email, phone, address_line1, address_line2, city, state, zip, country = 'US', tax_id, notes } = req.body || {};
    if (!user_id || !name) return res.status(400).json({ error: 'Missing required fields: user_id, name.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    const { data, error } = await sb.from('partner_clients').insert({
      user_id, partner_id: partner.partner_id,
      name, email: email || null, phone: phone || null,
      address_line1: address_line1 || null, address_line2: address_line2 || null,
      city: city || null, state: state || null, zip: zip || null, country,
      tax_id: tax_id || null, notes: notes || null,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  // PATCH — update client
  if (req.method === 'PATCH') {
    const { id, user_id, ...updates } = req.body || {};
    if (!id || !user_id) return res.status(400).json({ error: 'Missing id or user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    const allowed = ['name','email','phone','address_line1','address_line2','city','state','zip','country','tax_id','notes'];
    const patch = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));
    const { data, error } = await sb.from('partner_clients').update(patch).eq('id', id).eq('user_id', user_id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // DELETE — delete client
  if (req.method === 'DELETE') {
    const { id, user_id } = req.query;
    if (!id || !user_id) return res.status(400).json({ error: 'Missing id or user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });
    const { error } = await sb.from('partner_clients').delete().eq('id', id).eq('user_id', user_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
