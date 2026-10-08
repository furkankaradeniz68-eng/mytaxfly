async function requirePartnerAuth(req, res) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !apiKey.startsWith('mtf_live_')) {
    res.status(401).json({ error: 'Missing or invalid API key. Pass X-API-Key: mtf_live_...' });
    return null;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: partner, error } = await sb.from('partner_api_keys').select('*').eq('key', apiKey).eq('active', true).single();
  if (error || !partner) { res.status(401).json({ error: 'Invalid or revoked API key.' }); return null; }
  return { partner, sb };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  const { user_id, type = 'pl', from, to } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });

  const { data: membership } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('user_id', user_id).maybeSingle();
  if (!membership) return res.status(403).json({ error: 'User does not belong to this partner.' });

  let query = sb.from('transactions').select('type, amount, category, deductible, deductible_percent, date').eq('user_id', user_id);
  if (from) query = query.gte('date', from);
  if (to)   query = query.lte('date', to);

  const { data: txs, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const income   = txs.filter(t => t.type === 'income');
  const expenses = txs.filter(t => t.type === 'expense');
  const sum = arr => arr.reduce((acc, t) => acc + Number(t.amount), 0);

  if (type === 'pl') {
    return res.status(200).json({
      period: { from: from || null, to: to || null },
      income:   Math.round(sum(income)   * 100) / 100,
      expenses: Math.round(sum(expenses) * 100) / 100,
      net:      Math.round((sum(income) - sum(expenses)) * 100) / 100,
      transaction_count: txs.length,
    });
  }

  if (type === 'tax_summary') {
    const deductible = expenses.filter(t => t.deductible);
    const byCategory = {};
    for (const t of deductible) {
      const cat = t.category || 'Uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + Number(t.amount) * (Number(t.deductible_percent) / 100);
    }
    const categories = Object.entries(byCategory).map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
    return res.status(200).json({ period: { from: from || null, to: to || null }, total_deductible: Math.round(sum(deductible) * 100) / 100, categories });
  }

  if (type === 'categories') {
    const byCategory = {};
    for (const t of txs) {
      const cat = t.category || 'Uncategorized';
      if (!byCategory[cat]) byCategory[cat] = { income: 0, expenses: 0 };
      if (t.type === 'income')  byCategory[cat].income   += Number(t.amount);
      if (t.type === 'expense') byCategory[cat].expenses += Number(t.amount);
    }
    const categories = Object.entries(byCategory).map(([category, totals]) => ({ category, income: Math.round(totals.income * 100) / 100, expenses: Math.round(totals.expenses * 100) / 100 })).sort((a, b) => b.expenses - a.expenses);
    return res.status(200).json({ period: { from: from || null, to: to || null }, categories });
  }

  return res.status(400).json({ error: 'Invalid type. Use: pl, tax_summary, categories.' });
}
