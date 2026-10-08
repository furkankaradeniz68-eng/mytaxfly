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

// POST /api/partner/receipts
// Uploads a receipt file (image or PDF), stores it in Supabase Storage,
// and runs AI analysis to extract transaction data.
//
// Request: multipart/form-data
//   - file: the receipt file (image/jpeg, image/png, image/webp, application/pdf)
//   - user_id: the end-user's UUID
//   - llc_name: optional, helps AI determine expense vs income direction
//
// Response:
//   { file_url, vendor, amount, currency, date, type, category, deductible, deductible_percent, note }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  // Vercel doesn't parse multipart automatically — use formidable
  const formidable = (await import('formidable')).default;
  const fs = await import('fs');

  const form = formidable({ maxFileSize: 10 * 1024 * 1024 }); // 10 MB limit

  let fields, files;
  try {
    [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]));
    });
  } catch (err) {
    return res.status(400).json({ error: 'Invalid form data: ' + err.message });
  }

  const user_id = Array.isArray(fields.user_id) ? fields.user_id[0] : fields.user_id;
  const llc_name = Array.isArray(fields.llc_name) ? fields.llc_name[0] : (fields.llc_name || '');
  const fileObj = Array.isArray(files.file) ? files.file[0] : files.file;

  if (!user_id) return res.status(400).json({ error: 'Missing user_id.' });
  if (!fileObj) return res.status(400).json({ error: 'Missing file.' });

  // Verify user belongs to this partner
  const { data: pu } = await sb.from('partner_users').select('user_id').eq('partner_id', partner.partner_id).eq('user_id', user_id).maybeSingle();
  if (!pu) return res.status(403).json({ error: 'User does not belong to this partner.' });

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  const mimeType = fileObj.mimetype || fileObj.type || '';
  if (!allowedTypes.includes(mimeType)) {
    return res.status(400).json({ error: `Unsupported file type: ${mimeType}. Use JPEG, PNG, WebP, or PDF.` });
  }

  // Upload to Supabase Storage
  let fileUrl = null;
  try {
    const fileBuffer = fs.readFileSync(fileObj.filepath);
    const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1];
    const storagePath = `${user_id}/${Date.now()}_receipt.${ext}`;

    const { data: upData, error: upErr } = await sb.storage
      .from('receipts')
      .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: true });

    if (upErr) {
      console.error('Storage upload error:', upErr.message);
    } else if (upData?.path) {
      const { data: urlData } = sb.storage.from('receipts').getPublicUrl(upData.path);
      fileUrl = urlData?.publicUrl || null;
    }
  } catch (e) {
    console.error('Storage exception:', e.message);
  }

  // AI analysis
  const prompt = buildPrompt(llc_name);
  let analysisResult = null;

  try {
    const fileBuffer = fs.readFileSync(fileObj.filepath);
    const b64 = fileBuffer.toString('base64');

    const isImage = mimeType.startsWith('image/');
    const content = isImage
      ? [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } }, { type: 'text', text: prompt }]
      : [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: prompt }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content }],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'AI API error');

    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    analysisResult = JSON.parse(text);
  } catch (err) {
    console.error('AI analysis error:', err.message);
    return res.status(500).json({
      error: 'AI analysis failed: ' + err.message,
      file_url: fileUrl,
    });
  }

  return res.status(200).json({
    file_url: fileUrl,
    vendor: analysisResult.vendor || '',
    amount: analysisResult.amount || 0,
    currency: analysisResult.currency || 'USD',
    date: analysisResult.date || new Date().toISOString().split('T')[0],
    type: analysisResult.type || 'expense',
    category: analysisResult.category || 'Uncategorized',
    deductible: analysisResult.deductible ?? false,
    deductible_percent: analysisResult.deductible_percent ?? 0,
    note: analysisResult.note || '',
  });
}

function buildPrompt(llcName) {
  const entity = llcName ? `"${llcName}"` : 'the LLC';
  return `Analyze this financial document for a US LLC (LLC name: ${entity}).

Determine type by reading sender and recipient carefully:
- If a vendor/company sent this TO the LLC → type = "expense"
- If ${entity} issued this to a client → type = "income"
- Receipts, subscriptions, order confirmations from any vendor → "expense"
- Bank statements: positive/credit entries → income, negative/debit → expense

Respond ONLY with valid JSON, no extra text:
{"vendor":"name of the other party","amount":0.00,"currency":"original currency code","date":"YYYY-MM-DD","category":"Software & Tools / Marketing / Office & Supplies / Travel / Meals / Professional Services / Legal & Professional / Advertising / Payroll / Other","type":"expense or income","deductible":true,"deductible_percent":100,"note":"Brief IRS deductibility explanation (max 15 words)"}`;
}
