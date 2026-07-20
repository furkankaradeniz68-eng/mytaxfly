export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token, uid } = req.query;
  if (!token || !uid) return res.status(400).json({ error: 'Missing token or uid' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Validate token against user metadata
  const { data: { user }, error: userErr } = await sb.auth.admin.getUserById(uid);
  if (userErr || !user) return res.status(404).json({ error: 'User not found' });

  const storedToken = user.user_metadata?.share_token;
  if (!storedToken || storedToken !== token) {
    return res.status(403).json({ error: 'Invalid or expired share link' });
  }

  // Fetch transactions for this user
  const { data: txData } = await sb
    .from('transactions')
    .select('*')
    .eq('user_id', uid)
    .order('date', { ascending: false });

  return res.status(200).json({
    ok: true,
    llc_name: user.user_metadata?.llc_name || 'LLC',
    user_name: user.user_metadata?.name || '',
    transactions: txData || []
  });
}
