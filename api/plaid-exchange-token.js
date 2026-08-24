// Exchanges the public_token from Plaid Link for a permanent access_token.
// Called once after the user connects their bank in the Plaid Link widget.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { publicToken, institutionName, institutionId } = req.body;
  if (!publicToken) return res.status(400).json({ error: 'Missing publicToken' });

  const env = process.env.PLAID_ENV || 'sandbox';
  const exchangeRes = await fetch(`https://${env}.plaid.com/item/public_token/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      public_token: publicToken,
    }),
  });

  const exchangeData = await exchangeRes.json();
  if (!exchangeRes.ok || !exchangeData.access_token) {
    console.error('Plaid token exchange error:', exchangeData);
    return res.status(502).json({ error: exchangeData.error_message || 'Token exchange failed' });
  }

  const { error: dbError } = await sb.from('bank_connections').upsert(
    {
      user_id: user.id,
      bank: 'plaid',
      access_token: exchangeData.access_token,
      account_id: exchangeData.item_id,
      account_name: institutionName || 'Bank Account',
      last_synced_at: null,
      sync_cursor: null,
    },
    { onConflict: 'user_id,bank' }
  );

  if (dbError) {
    console.error('DB upsert error:', dbError);
    return res.status(500).json({ error: 'Failed to save connection' });
  }

  return res.status(200).json({ success: true, institutionName });
}
