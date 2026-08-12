export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mytaxfly.com');

  const { session_id } = req.query;
  if (!session_id || !session_id.startsWith('cs_')) {
    return res.status(400).json({ error: 'Invalid session_id' });
  }

  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const email = (session.customer_email || session.customer_details?.email || '').toLowerCase();
    return res.status(200).json({ email });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
