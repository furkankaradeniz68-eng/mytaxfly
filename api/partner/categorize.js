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

const CATEGORIES = [
  'Software & Tools', 'Marketing', 'Office & Supplies', 'Travel',
  'Meals', 'Professional Services', 'Legal & Professional',
  'Advertising', 'Payroll', 'Other', 'Uncategorized',
];

// POST /api/partner/categorize
// AI categorization for one or more transactions.
// Body: { transactions: [{ vendor, amount, note?, type? }] }
// Returns: [{ vendor, category, deductible, deductible_percent, note }]
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;

  const { transactions } = req.body || {};
  if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'Missing or empty transactions array.' });
  }
  if (transactions.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 transactions per request.' });
  }

  // Build the AI prompt
  const txList = transactions.map((t, i) =>
    `${i + 1}. vendor="${t.vendor || ''}", amount=${t.amount || 0}, type="${t.type || 'expense'}", note="${t.note || ''}"`
  ).join('\n');

  const prompt = `Categorize each US LLC transaction for IRS bookkeeping purposes.

Transactions:
${txList}

For each transaction return a JSON array (same order, same count) with:
- category: one of [${CATEGORIES.map(c => `"${c}"`).join(', ')}]
- deductible: true or false
- deductible_percent: 100, 50, or 0
- note: brief IRS deductibility reason (max 15 words)

Rules:
- Meals/Entertainment: deductible 50%
- Personal expenses: deductible false, 0%
- Income transactions (type=income): category "Income", deductible false
- Software, marketing, professional services: deductible true, 100%
- Travel for business: deductible true, 100%

Respond ONLY with a valid JSON array, no extra text. Example:
[{"category":"Software & Tools","deductible":true,"deductible_percent":100,"note":"Business software subscription — IRS §162"}]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'AI API error');

    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const results = JSON.parse(text);

    if (!Array.isArray(results) || results.length !== transactions.length) {
      throw new Error('AI returned unexpected number of results.');
    }

    // Merge AI results back with original transaction data
    const merged = transactions.map((t, i) => ({
      vendor: t.vendor,
      amount: t.amount,
      type: t.type || 'expense',
      category: results[i].category || 'Uncategorized',
      deductible: results[i].deductible ?? false,
      deductible_percent: results[i].deductible_percent ?? 0,
      note: results[i].note || '',
    }));

    return res.status(200).json({ results: merged });
  } catch (err) {
    console.error('Categorization error:', err);
    return res.status(500).json({ error: err.message || 'Categorization failed.' });
  }
}
