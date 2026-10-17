import { requirePartnerAuth } from './_auth.js';
import { fireWebhook } from './_webhook.js';

// POST /api/partner/webhook-test
// Sends a test payload to the partner's configured webhook URL.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const auth = await requirePartnerAuth(req, res);
  if (!auth) return;
  const { partner, sb } = auth;

  if (!partner.webhook_url) {
    return res.status(400).json({ error: 'Keine Webhook-URL konfiguriert. Bitte zuerst in den Einstellungen hinterlegen.' });
  }

  await fireWebhook(sb, {
    partnerId:  partner.partner_id,
    webhookUrl: partner.webhook_url,
    event:      'webhook.test',
    payload: {
      filing_id:       'test_' + Date.now(),
      external_id:     'test_client_001',
      form_type:       '5472_1120',
      tax_year:        2024,
      status:          'mailed',
      is_test:         true,
      letter_id:       null,
      tracking_number: null,
    },
  });

  return res.status(200).json({ success: true, message: 'Test-Webhook gesendet. Ergebnis im Webhooks-Tab sichtbar.' });
}
