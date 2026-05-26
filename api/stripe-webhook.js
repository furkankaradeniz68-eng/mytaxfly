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
    // Parse raw body for Stripe signature verification
    const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const session = event.data.object;

  if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created') {
    const email = session.customer_email || session.customer_details?.email;
    const plan = getPlanFromAmount(session.amount_total);

    if (email) {
      await sb.from('subscriptions').upsert({
        email: email.toLowerCase(),
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription || session.id,
        plan: plan,
        status: 'active',
      }, { onConflict: 'email' });
      console.log(`✅ Subscription activated for ${email} — Plan: ${plan}`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = session.customer;
    await sb.from('subscriptions')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('stripe_customer_id', customerId);
    console.log(`❌ Subscription cancelled for customer ${customerId}`);
  }

  return res.status(200).json({ received: true });
}

function getPlanFromAmount(amount) {
  if (!amount) return 'basic';
  if (amount <= 2900) return 'basic';
  if (amount <= 5900) return 'pro';
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
