// Processes referral reward when a referred user has an active subscription.
// Called once per referred user on first login.
// Referrer receives a Stripe balance credit equal to 1 month of their plan.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  // Get the referred user's profile
  const { data: profile } = await sb.from('profiles')
    .select('referred_by, referral_reward_given')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.referred_by)          return res.status(200).json({ skipped: true, reason: 'no referral' });
  if (profile.referral_reward_given)   return res.status(200).json({ skipped: true, reason: 'already rewarded' });

  // Referee must have an active subscription to trigger the reward
  const { data: refereeSub } = await sb.from('subscriptions')
    .select('status')
    .eq('email', user.email)
    .eq('status', 'active')
    .maybeSingle();

  if (!refereeSub) return res.status(200).json({ skipped: true, reason: 'no active subscription yet' });

  // Find the referrer's profile by referral_code
  const { data: referrerProfile } = await sb.from('profiles')
    .select('id, referral_count')
    .eq('referral_code', profile.referred_by)
    .maybeSingle();

  if (!referrerProfile) return res.status(200).json({ skipped: true, reason: 'referrer not found' });

  // Get referrer's email via Supabase Admin API
  const { data: { user: referrerUser }, error: ruErr } = await sb.auth.admin.getUserById(referrerProfile.id);
  if (ruErr || !referrerUser?.email) return res.status(200).json({ skipped: true, reason: 'referrer email not found' });

  // Get referrer's Stripe subscription
  const { data: referrerSub } = await sb.from('subscriptions')
    .select('stripe_customer_id, plan')
    .eq('email', referrerUser.email)
    .maybeSingle();

  if (!referrerSub?.stripe_customer_id) return res.status(200).json({ skipped: true, reason: 'referrer has no subscription' });

  // Credit = 1 month of referrer's plan (in cents)
  const planCredits = { basic: 900, pro: 2900, business: 4900 };
  const creditAmount = planCredits[referrerSub.plan] || 900;

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  try {
    await stripe.customers.createBalanceTransaction(referrerSub.stripe_customer_id, {
      amount: -creditAmount,
      currency: 'usd',
      description: `Referral reward — 1 free month (referred ${user.email})`,
    });
  } catch (stripeErr) {
    console.error('Stripe credit error:', stripeErr.message);
    return res.status(502).json({ error: 'Failed to apply referrer credit' });
  }

  // Mark referral as processed and increment referrer's count
  await Promise.all([
    sb.from('profiles').update({ referral_reward_given: true }).eq('id', user.id),
    sb.from('profiles').update({ referral_count: (referrerProfile.referral_count || 0) + 1 }).eq('id', referrerProfile.id),
  ]);

  console.log(`✅ Referral processed: ${user.email} → referrer ${referrerUser.email} (+${creditAmount / 100} USD credit)`);
  return res.status(200).json({ success: true, creditApplied: creditAmount });
}
