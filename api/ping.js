export default async function handler(req, res) {
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  await sb.from('subscriptions').select('count').limit(1);
  return res.status(200).json({ ok: true });
}
