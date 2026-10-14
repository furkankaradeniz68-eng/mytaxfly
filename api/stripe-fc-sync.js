// Fetches transactions from the user's Stripe Financial Connections account
// and imports them into MyTaxFly's transactions table.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { accountId } = req.body || {};

  // Load connection record — if accountId supplied, sync only that; else sync all
  let query = sb.from('bank_connections').select('*').eq('user_id', user.id).eq('bank', 'stripe_fc');
  if (accountId) query = query.eq('account_id', accountId);
  const { data: connections, error: connError } = await query;

  if (connError || !connections?.length) {
    return res.status(404).json({ error: 'No bank connection found' });
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  let totalImported = 0;
  let totalSkipped = 0;

  for (const conn of connections) {
    const stripeAccountId = conn.account_id;

    // Paginate transactions (Stripe FC returns max 100 per page)
    let allTx = [];
    let startingAfter;
    try {
      let hasMore = true;
      while (hasMore) {
        const params = { limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;
        if (conn.sync_cursor) params.starting_after = conn.sync_cursor;

        const page = await stripe.financialConnections.accounts.listTransactions(
          stripeAccountId,
          params
        );

        allTx = allTx.concat(page.data || []);
        hasMore = page.has_more;
        if (page.data?.length) startingAfter = page.data[page.data.length - 1].id;
        if (!page.has_more) break;
      }
    } catch (e) {
      console.error('Stripe FC transactions error:', e.message);
      if (e.code === 'financial_connections_account_inactive') {
        await sb.from('bank_connections').delete().eq('id', conn.id);
        return res.status(401).json({ error: 'Bank connection expired. Please reconnect.' });
      }
      return res.status(502).json({ error: e.message || 'Failed to fetch transactions from Stripe' });
    }

    if (!allTx.length) {
      await sb.from('bank_connections')
        .update({ last_synced_at: new Date().toISOString() })
        .eq('id', conn.id);
      continue;
    }

    // Stripe FC amount: positive = debit/expense (money leaving), negative = credit/income
    const mapped = allTx.map(t => ({
      user_id: user.id,
      external_id: t.id,
      source: 'stripe_fc',
      vendor: t.description || 'Bank Transfer',
      amount: Math.abs(t.amount) / 100,
      currency: (t.currency || 'usd').toUpperCase(),
      date: new Date(t.transacted_at * 1000).toISOString().slice(0, 10),
      type: t.amount > 0 ? 'expense' : 'income',
      category: 'Uncategorized',
      deductible: t.amount > 0,
      deductible_percent: 100,
      note: t.description || '',
      entity_id: null,
    }));

    // Dedup by external_id
    const extIds = mapped.map(t => t.external_id);
    const { data: existing } = await sb
      .from('transactions')
      .select('external_id')
      .eq('user_id', user.id)
      .in('external_id', extIds);

    const existingSet = new Set((existing || []).map(t => t.external_id));
    const toInsert = mapped.filter(t => !existingSet.has(t.external_id));

    if (toInsert.length > 0) {
      const { error: insertError } = await sb.from('transactions').insert(toInsert);
      if (insertError) {
        console.error('Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to save transactions' });
      }
    }

    totalImported += toInsert.length;
    totalSkipped += mapped.length - toInsert.length;

    // Update cursor to newest transaction so next sync only fetches what's new
    const newCursor = allTx[0]?.id;
    await sb.from('bank_connections')
      .update({ last_synced_at: new Date().toISOString(), sync_cursor: newCursor || conn.sync_cursor })
      .eq('id', conn.id);
  }

  return res.status(200).json({ imported: totalImported, skipped: totalSkipped });
}
