export const config = {
  api: { bodyParser: { sizeLimit: '12mb' } }
};

/**
 * Parse "City, ST 12345" → { city, state, zip }
 * Falls back gracefully when the format differs.
 */
function parseCityStateZip(raw = '') {
  const commaIdx = raw.indexOf(',');
  if (commaIdx === -1) {
    // No comma – treat the whole string as city, guess state/zip
    const parts = raw.trim().split(/\s+/);
    if (parts.length >= 3) {
      const zip   = parts[parts.length - 1];
      const state = parts[parts.length - 2];
      const city  = parts.slice(0, parts.length - 2).join(' ');
      return { city, state, zip };
    }
    return { city: raw.trim(), state: 'NY', zip: '10001' };
  }
  const city     = raw.slice(0, commaIdx).trim();
  const stateZip = raw.slice(commaIdx + 1).trim().split(/\s+/);
  const state    = stateZip[0] || 'NY';
  const zip      = stateZip[1] || '10001';
  return { city, state, zip };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { pdfBase64, fromName, fromAddress, fromCity, taxYear, formType } = req.body || {};
  if (!pdfBase64 || !fromName || !fromAddress) {
    return res.status(400).json({ error: 'Missing required fields (pdfBase64, fromName, fromAddress)' });
  }

  const LOB_API_KEY = process.env.LOB_API_KEY;
  if (!LOB_API_KEY) {
    return res.status(500).json({ error: 'LOB_API_KEY not configured' });
  }

  const { city, state, zip } = parseCityStateZip(fromCity);

  // Convert base64 PDF to binary
  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const pdfBlob   = new Blob([pdfBuffer], { type: 'application/pdf' });

  // Build multipart form for Lob Letters API
  const form = new FormData();

  // IRS mailing addresses — verified against IRS instructions (Dec 2024)
  // 5472+1120 / 5472 → PIN Unit per Form 5472 Instructions (12/2024).
  //   Write "Foreign Owned U.S. DE" across top. Fax alt: 855-887-7737.
  // 1120 standalone / 1065 / 7004 → P.O. Box 409101, Ogden UT 84409.
  const isDE = !formType || formType === '5472_1120' || formType === '5472';
  const irsName  = 'Internal Revenue Service';
  const irsLine1 = isDE ? '1973 Rulon White Blvd' : 'P.O. Box 409101';
  const irsLine2 = isDE ? 'M/S 6112 Attn: PIN Unit' : null;
  const irsCity  = 'Ogden';
  const irsState = 'UT';
  const irsZip   = isDE ? '84201' : '84409';

  form.append('to[name]',             irsName);
  form.append('to[address_line1]',    irsLine1);
  if (irsLine2) form.append('to[address_line2]', irsLine2);
  form.append('to[address_city]',     irsCity);
  form.append('to[address_state]',    irsState);
  form.append('to[address_zip]',      irsZip);
  form.append('to[address_country]',  'US');

  // Sender — LLC address from tax profile
  form.append('from[name]',            fromName);
  form.append('from[address_line1]',   fromAddress);
  form.append('from[address_city]',    city);
  form.append('from[address_state]',   state);
  form.append('from[address_zip]',     zip);
  form.append('from[address_country]', 'US');

  // Letter options
  form.append('color',         'false');          // black & white is fine for IRS forms
  form.append('double_sided',  'true');
  form.append('extra_service', 'certified');      // USPS Certified Mail with tracking
  form.append('use_type',      'operational');    // required by Lob; IRS filings = operational

  // Attach PDF
  form.append('file', pdfBlob, `FilingPackage_${taxYear || 'current'}.pdf`);

  const auth = 'Basic ' + Buffer.from(LOB_API_KEY + ':').toString('base64');

  try {
    const lobRes = await fetch('https://api.lob.com/v1/letters', {
      method:  'POST',
      headers: { Authorization: auth },
      body:    form
    });

    const data = await lobRes.json();

    if (!lobRes.ok) {
      const msg = data?.error?.message || data?.error || 'Lob API error';
      return res.status(500).json({ error: msg, detail: data });
    }

    return res.status(200).json({
      ok:                true,
      id:                data.id,
      tracking:          data.tracking_number          || null,
      expected_delivery: data.expected_delivery_date   || null,
      status:            data.status                   || null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
