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

function calcTotals(items = []) {
  const subtotal = items.reduce((sum, item) => sum + (Number(item.quantity) * Number(item.unit_price)), 0);
  return Math.round(subtotal * 100) / 100;
}

export default async function handler(req, res) {
  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  async function verifyUser(userId) {
    const { data } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('user_id', userId).maybeSingle();
    return !!data;
  }

  // GET — list or get single invoice
  if (req.method === 'GET') {
    const { user_id, invoice_id, status, client_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    if (invoice_id) {
      const { data, error } = await sb.from('partner_invoices').select('*, items:partner_invoice_items(*)').eq('id', invoice_id).eq('user_id', user_id).single();
      if (error || !data) return res.status(404).json({ error: 'Invoice not found.' });
      return res.status(200).json(data);
    }

    let query = sb.from('partner_invoices').select('*, items:partner_invoice_items(*)').eq('user_id', user_id).order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (client_id) query = query.eq('client_id', client_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ invoices: data });
  }

  // POST — create invoice with line items
  if (req.method === 'POST') {
    const {
      user_id, client_id, invoice_number, issue_date, due_date,
      currency = 'USD', notes = '', items = [], status = 'draft',
    } = req.body || {};

    if (!user_id || !client_id || !issue_date || !due_date) {
      return res.status(400).json({ error: 'Missing required fields: user_id, client_id, issue_date, due_date.' });
    }
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });
    if (!items.length) return res.status(400).json({ error: 'Invoice must have at least one line item.' });

    const subtotal = calcTotals(items);

    // Auto-generate invoice number if not provided
    let invNumber = invoice_number;
    if (!invNumber) {
      const { count } = await sb.from('partner_invoices').select('id', { count: 'exact', head: true }).eq('user_id', user_id);
      invNumber = `INV-${String((count || 0) + 1).padStart(4, '0')}`;
    }

    const { data: invoice, error: invError } = await sb.from('partner_invoices').insert({
      user_id, partner_id: partner.partner_id, client_id,
      invoice_number: invNumber, issue_date, due_date,
      currency, notes, status, subtotal, total: subtotal,
    }).select().single();
    if (invError) return res.status(500).json({ error: invError.message });

    const lineItems = items.map(item => ({
      invoice_id: invoice.id,
      description: item.description,
      quantity: Number(item.quantity) || 1,
      unit_price: Number(item.unit_price) || 0,
      amount: Math.round(Number(item.quantity) * Number(item.unit_price) * 100) / 100,
    }));

    const { error: itemsError } = await sb.from('partner_invoice_items').insert(lineItems);
    if (itemsError) return res.status(500).json({ error: itemsError.message });

    const { data: full } = await sb.from('partner_invoices').select('*, items:partner_invoice_items(*)').eq('id', invoice.id).single();
    return res.status(201).json(full);
  }

  // PATCH — update invoice status or fields
  if (req.method === 'PATCH') {
    const { id, user_id, items, ...updates } = req.body || {};
    if (!id || !user_id) return res.status(400).json({ error: 'Missing id or user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });

    const allowed = ['status','due_date','notes','currency','invoice_number'];
    const patch = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));

    // Recalculate totals if items are updated
    if (items && items.length) {
      patch.subtotal = calcTotals(items);
      patch.total = patch.subtotal;
      await sb.from('partner_invoice_items').delete().eq('invoice_id', id);
      const lineItems = items.map(item => ({
        invoice_id: id,
        description: item.description,
        quantity: Number(item.quantity) || 1,
        unit_price: Number(item.unit_price) || 0,
        amount: Math.round(Number(item.quantity) * Number(item.unit_price) * 100) / 100,
      }));
      await sb.from('partner_invoice_items').insert(lineItems);
    }

    const { data, error } = await sb.from('partner_invoices').update(patch).eq('id', id).eq('user_id', user_id).select('*, items:partner_invoice_items(*)').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // DELETE — delete invoice
  if (req.method === 'DELETE') {
    const { id, user_id } = req.query;
    if (!id || !user_id) return res.status(400).json({ error: 'Missing id or user_id.' });
    if (!await verifyUser(user_id)) return res.status(403).json({ error: 'User does not belong to this partner.' });
    await sb.from('partner_invoice_items').delete().eq('invoice_id', id);
    const { error } = await sb.from('partner_invoices').delete().eq('id', id).eq('user_id', user_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
