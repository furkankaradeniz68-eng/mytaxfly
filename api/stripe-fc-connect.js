// Called after the user completes the Stripe Financial Connections flow.
// Saves the connected account to bank_connections and subscribes to transaction data.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { accountId, accountName, institutionName } = req.body;
  if (!accountId) return res.status(400).json({ error: 'Missing accountId' });

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  try {
    // Subscribe the account to transaction data so we can fetch transactions later
    await stripe.financialConnections.accounts.subscribe(accountId, {
      features: ['transactions'],
    });
  } catch (err) {
    // If already subscribed or not supported, continue — non-fatal
    console.warn('FC subscribe warning:', err.message);
  }

  const { error: dbError } = await sb.from('bank_connections').upsert(
    {
      user_id: user.id,
      bank: 'stripe',
      access_token: accountId,          // reuse access_token column for FC account ID
      account_id: accountId,
      account_name: accountName || institutionName || 'Bank Account',
      institution_name: institutionName || null,
      last_synced_at: null,
      sync_cursor: null,
    },
    { onConflict: 'user_id,bank' }
  );

  if (dbError) {
    console.error('DB upsert error:', dbError);
    return res.status(500).json({ error: 'Failed to save connection' });
  }

  return res.status(200).json({ success: true, accountName: accountName || institutionName });
}
