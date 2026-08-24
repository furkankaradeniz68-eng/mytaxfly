// Syncs transactions from Plaid using the cursor-based /transactions/sync endpoint.
// Cursor persists in bank_connections so each call only fetches what's new.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: conn, error: connError } = await sb
    .from('bank_connections')
    .select('*')
    .eq('user_id', user.id)
    .eq('bank', 'plaid')
    .single();

  if (connError || !conn) return res.status(404).json({ error: 'No bank connection found' });

  const env = process.env.PLAID_ENV || 'sandbox';

  async function plaidPost(path, body) {
    const r = await fetch(`https://${env}.plaid.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        ...body,
      }),
    });
    return { status: r.status, body: await r.json() };
  }

  // Paginate through all new transactions using cursor
  let cursor = conn.sync_cursor || undefined;
  let added = [];
  let nextCursor = cursor;

  try {
    let hasMore = true;
    while (hasMore) {
      const { status, body } = await plaidPost('/transactions/sync', {
        access_token: conn.access_token,
        ...(cursor ? { cursor } : {}),
        count: 500,
      });

      if (status === 400 && body.error_code === 'ITEM_LOGIN_REQUIRED') {
        await sb.from('bank_connections').delete().eq('id', conn.id);
        return res.status(401).json({ error: 'Bank login required. Please reconnect your bank.' });
      }
      if (status !== 200) {
        console.error('Plaid sync error:', body);
        return res.status(502).json({ error: body.error_message || 'Plaid API error' });
      }

      added = added.concat(body.added || []);
      hasMore = body.has_more;
      nextCursor = body.next_cursor;
      cursor = nextCursor;
    }
  } catch (e) {
    console.error('Plaid fetch error:', e);
    return res.status(502).json({ error: 'Failed to fetch from Plaid' });
  }

  // Filter to posted (non-pending) transactions only
  const posted = added.filter(t => !t.pending);

  if (!posted.length) {
    await sb.from('bank_connections')
      .update({ last_synced_at: new Date().toISOString(), sync_cursor: nextCursor })
      .eq('id', conn.id);
    return res.status(200).json({ imported: 0, skipped: 0 });
  }

  // Map Plaid transactions to MyTaxFly schema.
  // Plaid convention: amount > 0 = debit (expense), amount < 0 = credit (income).
  const mapped = posted.map(t => {
    const isExpense = t.amount > 0;
    return {
      user_id: user.id,
      external_id: t.transaction_id,
      source: 'plaid',
      vendor: t.merchant_name || t.name || 'Bank Transfer',
      amount: Math.abs(t.amount),
      currency: t.iso_currency_code || 'USD',
      date: t.date,
      type: isExpense ? 'expense' : 'income',
      category: 'Uncategorized',
      deductible: isExpense,
      deductible_percent: 100,
      note: t.name || '',
      entity_id: null,
    };
  });

  // Dedup by external_id
  const extIds = mapped.map(t => t.external_id);
  const { data: existing } = await sb
    .from('transactions')
    .select('external_id')
    .eq('user_id', user.id)
    .in('external_id', extIds);

  const existingSet = new Set((existing || []).map(t => t.external_id));
  const toInsert = mapped.filter(t => !existingSet.has(t.external_id));

  let imported = 0;
  if (toInsert.length > 0) {
    const { error: insertError } = await sb.from('transactions').insert(toInsert);
    if (insertError) {
      console.error('Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save transactions' });
    }
    imported = toInsert.length;
  }

  await sb.from('bank_connections')
    .update({ last_synced_at: new Date().toISOString(), sync_cursor: nextCursor })
    .eq('id', conn.id);

  return res.status(200).json({ imported, skipped: mapped.length - imported, total: mapped.length });
}
