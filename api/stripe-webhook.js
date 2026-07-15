export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  let event;
  try {
    const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const obj = event.data.object;

  // ── Checkout completed (new subscription) ─────────────────
  if (event.type === 'checkout.session.completed') {
    const email = obj.customer_email || obj.customer_details?.email;
    const plan = getPlanFromAmount(obj.amount_total);

    if (email) {
      const normalizedEmail = email.toLowerCase();
      await sb.from('subscriptions').upsert({
        email: normalizedEmail,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.subscription || obj.id,
        plan,
        status: 'active',
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' });
      console.log(`✅ New subscription: ${normalizedEmail} — ${plan}`);

      // Auto-create account or send magic link
      try {
        const { error: inviteError } = await sb.auth.admin.inviteUserByEmail(normalizedEmail, {
          redirectTo: 'https://mytaxfly.com/dashboard',
          data: { plan }
        });
        if (inviteError) {
          // User already exists — send magic link
          await sb.auth.admin.generateLink({
            type: 'magiclink',
            email: normalizedEmail,
            options: { redirectTo: 'https://mytaxfly.com/dashboard' }
          });
        }
      } catch(e) {
        console.error('Email error:', e.message);
      }
    }
  }

  // ── Subscription updated (plan change / renewal) ───────────
  if (event.type === 'customer.subscription.updated') {
    const plan = getPlanFromPriceId(obj.items?.data?.[0]?.price?.id);
    if (plan) {
      await sb.from('subscriptions')
        .update({ plan, status: obj.status, updated_at: new Date().toISOString() })
        .eq('stripe_customer_id', obj.customer);
      console.log(`🔄 Subscription updated: ${obj.customer} — ${plan}`);
    }
  }

  // ── Subscription cancelled ─────────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    await sb.from('subscriptions')
      .update({ status: 'cancelled', plan: 'basic', updated_at: new Date().toISOString() })
      .eq('stripe_customer_id', obj.customer);
    console.log(`❌ Subscription cancelled: ${obj.customer}`);
  }

  return res.status(200).json({ received: true });
}

// Map Stripe price IDs to plan names
const PRICE_MAP = {
  '4gM28t71peNx9iCfKk9IQ00': 'basic',   // basic monthly
  '8x214pclJcFpdySgOo9IQ01': 'basic',   // basic yearly
  '3cI6oJ71p0WH7audCc9IQ02': 'pro',     // pro monthly
  'aFa4gBgBZ9tdgL4bu49IQ03': 'pro',     // pro yearly
  'aFa3cxbhF5cXbqKdCc9IQ04': 'business', // business monthly
  'cNi5kFbhFdJt1Qa7dO9IQ05': 'business'  // business yearly
};

function getPlanFromPriceId(priceId) {
  if (!priceId) return null;
  // Match by suffix of price ID
  for (const [key, plan] of Object.entries(PRICE_MAP)) {
    if (priceId.includes(key)) return plan;
  }
  return null;
}

function getPlanFromAmount(amount) {
  if (!amount) return 'basic';
  // Prices in cents: Basic $9=900, Pro $29=2900, Business $49=4900
  if (amount <= 900)  return 'basic';
  if (amount <= 2900) return 'pro';
  if (amount <= 4900) return 'business';
  // Yearly (approx 10 months)
  if (amount <= 9000)  return 'basic';
  if (amount <= 29000) return 'pro';
  return 'business';
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
