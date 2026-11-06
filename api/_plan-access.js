// Keep in sync with ADMIN_EMAILS in dashboard.html.
const ADMIN_EMAILS = ['furkan.karadeniz68@googlemail.com', 'anil@aynauniverse.com', 'info@llc-starten.de', 'solutionthirteenllc@gmail.com', 'sales@taxxit-consulting.com'];

export async function hasBusinessAccess(sb, user) {
  const email = (user.email || '').toLowerCase();
  if (ADMIN_EMAILS.includes(email)) return true;

  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profile?.role === 'advisor' || profile?.role === 'admin') return true;

  const { data: sub } = await sb.from('subscriptions').select('plan, status').eq('email', email).maybeSingle();
  return sub?.plan === 'business' && sub.status !== 'cancelled';
}
