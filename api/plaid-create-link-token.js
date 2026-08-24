// Creates a Plaid Link token so the browser can initialize the Plaid Link widget.
// The link_token is short-lived (30 min) and tied to the user.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const env = process.env.PLAID_ENV || 'sandbox';
  const plaidRes = await fetch(`https://${env}.plaid.com/link/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      user: { client_user_id: user.id },
      client_name: 'MyTaxFly',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    }),
  });

  const data = await plaidRes.json();
  if (!plaidRes.ok || !data.link_token) {
    console.error('Plaid link token error:', data);
    return res.status(502).json({ error: data.error_message || 'Failed to create link token' });
  }

  return res.status(200).json({ link_token: data.link_token });
}
