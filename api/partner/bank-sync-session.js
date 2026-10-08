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

// POST /api/partner/bank-sync-session
// Creates a Stripe Financial Connections session for the end-user.
// Returns a client_secret the partner frontend uses to open the bank connection flow.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });

  // Verify user belongs to this partner
  const { data: pu } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('user_id', user_id).maybeSingle();
  if (!pu) return res.status(403).json({ error: 'User does not belong to this partner.' });

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
    return res.status(502).json({ error: err.message || 'Failed to create session.' });
  }
}
