export default async function handler(req, res) {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data, error } = await sb
    .from('subscriptions')
    .select('status, plan')
    .eq('email', email)
    .eq('status', 'active')
    .single();

  if (error || !data) {
    return res.status(200).json({ found: false });
  }

  return res.status(200).json({ found: true, plan: data.plan });
}
