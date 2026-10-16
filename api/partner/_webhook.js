// Fires a webhook to the partner's registered URL and logs the delivery attempt.
// partner_api_keys must have a webhook_url column.
// webhook_deliveries table stores every attempt for debugging.
export async function fireWebhook(sb, { partnerId, webhookUrl, event, payload }) {
  if (!webhookUrl) return;

  const body = JSON.stringify({
    event,
    ...payload,
    timestamp: new Date().toISOString(),
  });

  let statusCode   = null;
  let responseBody = null;
  let success      = false;

  try {
    const resp = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-MyTaxFly-Event': event },
      body,
      signal:  AbortSignal.timeout(10_000),
    });
    statusCode   = resp.status;
    responseBody = await resp.text().catch(() => null);
    success      = resp.ok;
  } catch (err) {
    responseBody = err.message;
  }

  await sb.from('webhook_deliveries').insert({
    partner_id:    partnerId,
    event,
    url:           webhookUrl,
    payload:       body,
    status_code:   statusCode,
    response_body: responseBody?.slice(0, 1000) ?? null,
    success,
  }).catch(e => console.error('Webhook delivery log error:', e.message));
}
