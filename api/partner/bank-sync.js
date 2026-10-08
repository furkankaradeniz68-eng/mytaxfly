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

function mapCategory(stripeCategory, isExpense) {
  if (!isExpense) return 'Income';
  if (!stripeCategory) return 'Uncategorized';
  const cat = stripeCategory.toLowerCase();
  if (cat.includes('travel') || cat.includes('airline') || cat.includes('hotel')) return 'Travel';
  if (cat.includes('food') || cat.includes('restaurant') || cat.includes('dining')) return 'Meals';
  if (cat.includes('software') || cat.includes('subscription') || cat.includes('saas') ||
      cat.includes('internet') || cat.includes('telecom')) return 'Software & Tools';
  if (cat.includes('advertis') || cat.includes('marketing')) return 'Advertising';
  if (cat.includes('legal') || cat.includes('accounting') || cat.includes('tax')) return 'Legal & Professional';
  if (cat.includes('office') || cat.includes('supplies') || cat.includes('shipping')) return 'Office & Supplies';
  if (cat.includes('transfer') || cat.includes('bank') || cat.includes('fee')) return 'Other';
  if (cat.includes('payroll') || cat.includes('salary')) return 'Payroll';
  return 'Uncategorized';
}

// POST /api/partner/bank-sync
// Fetches new transactions from the user's connected Stripe Financial Connections account
// and imports them into MyTaxFly. Uses cursor-based pagination to avoid re-importing.
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

  // Load the stored connection
  const { data: conn, error: connError } = await sb
    .from('bank_connections')
    .select('*')
    .eq('user_id', user_id)
    .eq('bank', 'stripe')
    .single();

  if (connError || !conn) {
    return res.status(404).json({ error: 'No bank connection found. Connect bank first via /api/partner/bank-sync-connect.' });
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  const allTransactions = [];
  let startingAfter = conn.sync_cursor || undefined;

  try {
    let hasMore = true;
    while (hasMore) {
      const params = { account: conn.account_id, limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;

      const page = await stripe.financialConnections.transactions.list(params);
      allTransactions.push(...(page.data || []));
      hasMore = page.has_more;

      if (page.data && page.data.length > 0) {
        startingAfter = page.data[page.data.length - 1].id;
      } else {
        hasMore = false;
      }
    }
  } catch (err) {
    console.error('Stripe FC transaction fetch error:', err);
    return res.status(502).json({ error: err.message || 'Failed to fetch transactions from Stripe.' });
  }

  if (!allTransactions.length) {
    await sb.from('bank_connections').update({ last_synced_at: new Date().toISOString() }).eq('id', conn.id);
    return res.status(200).json({ imported: 0, skipped: 0, total: 0 });
  }

  // Map Stripe FC transactions to MyTaxFly format
  // Stripe: positive = credit (money in), negative = debit (money out), amounts in cents
  const mapped = allTransactions.map(t => {
    const amountCents = t.amount;
    const isExpense = amountCents < 0;
    const category = mapCategory(t.category, isExpense);
    return {
      user_id,
      external_id: t.id,
      source: 'stripe_fc',
      vendor: t.description || 'Bank Transaction',
      amount: Math.abs(amountCents) / 100,
      currency: (t.currency || 'usd').toUpperCase(),
      date: new Date(t.transacted_at * 1000).toISOString().split('T')[0],
      type: isExpense ? 'expense' : 'income',
      category,
      deductible: isExpense && category !== 'Other' && category !== 'Uncategorized',
      deductible_percent: 100,
      note: t.description || '',
      entity_id: null,
    };
  });

  // Dedup by external_id to avoid double-imports on re-sync
  const extIds = mapped.map(t => t.external_id);
  const { data: existing } = await sb
    .from('transactions')
    .select('external_id')
    .eq('user_id', user_id)
    .in('external_id', extIds);

  const existingSet = new Set((existing || []).map(t => t.external_id));
  const toInsert = mapped.filter(t => !existingSet.has(t.external_id));

  let imported = 0;
  if (toInsert.length > 0) {
    const { error: insertError } = await sb.from('transactions').insert(toInsert);
    if (insertError) {
      console.error('Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save transactions.' });
    }
    imported = toInsert.length;
  }

  const newCursor = allTransactions.length > 0 ? allTransactions[0].id : conn.sync_cursor;
  await sb.from('bank_connections').update({
    last_synced_at: new Date().toISOString(),
    sync_cursor: newCursor,
  }).eq('id', conn.id);

  return res.status(200).json({
    imported,
    skipped: mapped.length - imported,
    total: mapped.length,
  });
}
