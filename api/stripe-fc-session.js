// Creates a Stripe Financial Connections session so the browser can open
// the Stripe Link modal and let the user connect their bank account.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  // Resolve or create a Stripe customer so we can attach FC accounts to it
  const { data: profile } = await sb
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .maybeSingle();

  let customerId = profile?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { supabase_uid: user.id } });
    customerId = customer.id;
    await sb.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  const session = await stripe.financialConnections.sessions.create({
    account_holder: { type: 'customer', customer: customerId },
    permissions: ['transactions', 'balances', 'ownership'],
    filters: { countries: ['US'] },
  });

  return res.status(200).json({
    clientSecret: session.client_secret,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  });
}
