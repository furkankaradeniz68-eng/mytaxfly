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

// POST /api/partner/bank-sync-connect
// Called after the user completes the Stripe Financial Connections flow.
// Saves the connected bank account and subscribes it for transaction data.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const { user_id, accountId, accountName, institutionName } = req.body || {};
  if (!user_id || !accountId) return res.status(400).json({ error: 'Missing user_id or accountId.' });

  // Verify user belongs to this partner
  const { data: pu } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('user_id', user_id).maybeSingle();
  if (!pu) return res.status(403).json({ error: 'User does not belong to this partner.' });

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  try {
    await stripe.financialConnections.accounts.subscribe(accountId, { features: ['transactions'] });
  } catch (err) {
    // Non-fatal: already subscribed or account type doesn't support it
    console.warn('FC subscribe warning:', err.message);
  }

  const { error: dbError } = await sb.from('bank_connections').upsert(
    {
      user_id,
      bank: 'stripe',
      access_token: accountId,
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
    return res.status(500).json({ error: 'Failed to save bank connection.' });
  }

  return res.status(200).json({ success: true, accountName: accountName || institutionName || 'Bank Account' });
}
