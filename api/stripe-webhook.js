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
      const normalizedEmail = email.toLowerCase();

      // Save subscription to Supabase
      await sb.from('subscriptions').upsert({
        email: normalizedEmail,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription || session.id,
        plan: plan,
        status: 'active',
      }, { onConflict: 'email' });
      console.log(`✅ Subscription activated for ${normalizedEmail} — Plan: ${plan}`);

      // Send magic link email so customer can access dashboard
      try {
        const { error: inviteError } = await sb.auth.admin.inviteUserByEmail(normalizedEmail, {
          redirectTo: 'https://mytaxfly.vercel.app/dashboard.html',
          data: { plan }
        });
        if (inviteError) {
          // User might already exist — send magic link instead
          const { error: magicError } = await sb.auth.admin.generateLink({
            type: 'magiclink',
            email: normalizedEmail,
            options: { redirectTo: 'https://mytaxfly.vercel.app/dashboard.html' }
          });
          if (magicError) console.error('Magic link error:', magicError.message);
          else console.log(`📧 Magic link sent to ${normalizedEmail}`);
        } else {
          console.log(`📧 Invite email sent to ${normalizedEmail}`);
        }
      } catch(e) {
        console.error('Email sending failed:', e.message);
      }
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
  // Monthly prices (in cents): Basic=2900, Pro=5900, Business=9900
  // Yearly prices (in cents):  Basic=27600, Pro=56400, Business=94800
  if (amount <= 2900) return 'basic';
  if (amount <= 5900) return 'pro';
  if (amount <= 9900) return 'business';
  if (amount <= 27600) return 'basic';
  if (amount <= 56400) return 'pro';
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
