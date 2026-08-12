// ── Stripe Webhook Handler ────────────────────────────────────────────────────
// CRITICAL: bodyParser must be disabled so Stripe signature verification works.
// Without this, Vercel parses the body and the raw bytes are lost → sig check fails.
export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  // ── Signature verification ─────────────────────────────────────────────────
  let event;
  try {
    const rawBody = await getRawBody(req);          // must be Buffer, not string
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook sig failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const obj = event.data.object;
  console.log(`📨 Stripe event: ${event.type}`);

  // ── checkout.session.completed  (new subscriber) ──────────────────────────
  if (event.type === 'checkout.session.completed') {
    const email = (obj.customer_email || obj.customer_details?.email || '').toLowerCase();
    if (!email) {
      console.error('❌ No email in checkout session');
      return res.status(200).json({ received: true });
    }

    // Get price ID via 3 methods (each is a fallback for the previous)
    const priceId = obj.line_items?.data?.[0]?.price?.id
      ?? await getFirstPriceId(stripe, obj.id)
      ?? await getPriceFromSubscription(stripe, obj.subscription);
    const plan = getPlanFromPriceId(priceId) || getPlanFromAmount(obj.amount_total);
    console.log(`💳 priceId=${priceId} → plan=${plan} (amount=${obj.amount_total})`);

    const { error: upsertErr } = await sb.from('subscriptions').upsert({
      email,
      stripe_customer_id:      obj.customer,
      stripe_subscription_id:  obj.subscription || obj.id,
      plan,
      status:                  'active',
      updated_at:              new Date().toISOString()
    }, { onConflict: 'email' });

    if (upsertErr) console.error('❌ Supabase upsert error:', upsertErr.message);
    else console.log(`✅ Subscription activated: ${email} → ${plan}`);
  }

  // ── customer.subscription.updated  (plan change / renewal) ────────────────
  if (event.type === 'customer.subscription.updated') {
    const priceId = obj.items?.data?.[0]?.price?.id;
    const plan    = getPlanFromPriceId(priceId);
    const status  = obj.status === 'active' ? 'active' : obj.status;

    if (obj.customer) {
      const update = { status, updated_at: new Date().toISOString() };
      if (plan) update.plan = plan;
      const { error } = await sb.from('subscriptions')
        .update(update)
        .eq('stripe_customer_id', obj.customer);
      if (error) console.error('❌ Update error:', error.message);
      else console.log(`🔄 Subscription updated: ${obj.customer} → ${plan || 'same plan'} (${status})`);
    }
  }

  // ── customer.subscription.deleted  (cancellation) ─────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const { error } = await sb.from('subscriptions')
      .update({ status: 'cancelled', plan: 'basic', updated_at: new Date().toISOString() })
      .eq('stripe_customer_id', obj.customer);
    if (error) console.error('❌ Cancel error:', error.message);
    else console.log(`❌ Subscription cancelled: ${obj.customer}`);
  }

  // ── invoice.payment_failed  (dunning / payment issue) ─────────────────────
  if (event.type === 'invoice.payment_failed') {
    const customerId = obj.customer;
    if (customerId) {
      await sb.from('subscriptions')
        .update({ status: 'past_due', updated_at: new Date().toISOString() })
        .eq('stripe_customer_id', customerId);
      console.log(`⚠️ Payment failed for: ${customerId}`);
    }
  }

  return res.status(200).json({ received: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect raw request body as a single Buffer.
 * MUST return Buffer (not string) for Stripe sig verification.
 */
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Get price ID from the subscription object directly.
 * Fallback when both line_items and session expand fail.
 */
async function getPriceFromSubscription(stripe, subscriptionId) {
  if (!subscriptionId) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return sub.items?.data?.[0]?.price?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch first line-item price ID from Stripe when not included in the event.
 * checkout.session.completed doesn't include line_items by default.
 */
async function getFirstPriceId(stripe, sessionId) {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items']
    });
    return session.line_items?.data?.[0]?.price?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Map Stripe Price IDs → plan name.
 * ⚠️  Replace the placeholder IDs below with your real Stripe Price IDs.
 *     Find them: Stripe Dashboard → Products → your product → Prices
 *     They look like: price_1ABC123defGHIjkl456
 */
const PRICE_MAP = {
  // ── LIVE prices ──────────────────────────────────────────────────────────
  'price_1TtR5hQVuu0Fy4LwLWhuBC5A': 'basic',    // Basic Monthly
  'price_1TtR5RQVuu0Fy4LwHXV6FRvr': 'basic',    // Basic Yearly
  'price_1TtR6YQVuu0Fy4LwDXzlmuIG': 'pro',      // Pro Monthly
  'price_1TtR6YQVuu0Fy4LwbksIqz6N': 'pro',      // Pro Yearly
  'price_1TtR6nQVuu0Fy4Lw3pJFALSo': 'business', // Business Monthly
  'price_1TtR71QVuu0Fy4LwFLTlWWDA': 'business', // Business Yearly
};

function getPlanFromPriceId(priceId) {
  if (!priceId) return null;
  return PRICE_MAP[priceId] ?? null;
}

/**
 * Fallback: derive plan from checkout total (in cents).
 * Update these amounts to match your actual Stripe prices.
 *   Basic:    $9/mo  → 900   | $90/yr  → 9000
 *   Pro:      $29/mo → 2900  | $290/yr → 29000
 *   Business: $49/mo → 4900  | $490/yr → 49000
 */
function getPlanFromAmount(cents) {
  if (!cents || cents <= 0) return 'basic';
  if (cents <= 900)   return 'basic';
  if (cents <= 2900)  return 'pro';
  if (cents <= 4900)  return 'business';
  if (cents <= 9000)  return 'basic';   // yearly basic
  if (cents <= 29000) return 'pro';     // yearly pro
  return 'business';                    // yearly business
}
