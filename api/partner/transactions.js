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

  async function verifyUser(userId) {
    const { data } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('user_id', userId).maybeSingle();
    return !!data;
  }

  if (req.method === 'GET') {
    const { user_id, from, to, type, category, source, search, limit = 100, offset = 0 } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    let query = sb.from('transactions')
      .select('id, date, vendor, amount, currency, type, category, deductible, deductible_percent, note, source, external_id, filename, file_url, created_at')
      .eq('user_id', user_id).order('date', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (from)     query = query.gte('date', from);
    if (to)       query = query.lte('date', to);
    if (type)     query = query.eq('type', type);
    if (category) query = query.eq('category', category);
    if (source)   query = query.eq('source', source);         // upload | manual | stripe_fc | partner_api
    if (search)   query = query.ilike('vendor', `%${search}%`); // Vendor-Suche

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ transactions: data, limit: Number(limit), offset: Number(offset) });
  }

  if (req.method === 'POST') {
    const { user_id, date, vendor, amount, currency = 'USD', type, category, deductible = false, deductible_percent = 100, note = '' } = req.body || {};
    if (!user_id || !date || !vendor || amount == null || !type) return res.status(400).json({ error: 'Missing required fields: user_id, date, vendor, amount, type.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    const { data, error } = await sb.from('transactions').insert({ user_id, date, vendor, amount, currency, type, category: category || 'Uncategorized', deductible, deductible_percent, note, source: 'partner_api' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === 'PATCH') {
    const { id, user_id, ...updates } = req.body || {};
    if (!id || !user_id) return res.status(400).json({ error: 'Missing id or user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    const allowed = ['date','vendor','amount','currency','type','category','deductible','deductible_percent','note'];
    const patch = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));
    const { data, error } = await sb.from('transactions').update(patch).eq('id', id).eq('user_id', user_id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'DELETE') {
    const { id, user_id } = req.query;
    if (!id || !user_id) return res.status(400).json({ error: 'Missing id or user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });
    const { error } = await sb.from('transactions').delete().eq('id', id).eq('user_id', user_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
