// Creates a Stripe Financial Connections session so the browser can open the
// bank-connection flow. The client_secret is short-lived and single-use.
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

  try {
    const session = await stripe.financialConnections.sessions.create({
      account_holder: { type: 'individual' },
      permissions: ['transactions', 'balances'],
      filters: { countries: ['US'] },
    });

    return res.status(200).json({ client_secret: session.client_secret });
  } catch (err) {
    console.error('Stripe FC session error:', err);
    return res.status(502).json({ error: err.message || 'Failed to create session' });
  }
}
