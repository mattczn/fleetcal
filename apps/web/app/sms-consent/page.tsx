/**
 * SMS Consent — publicly accessible at /sms-consent.
 *
 * Built to satisfy Twilio's Opt-In Policy Proof requirement for
 * A2P 10DLC campaign registration. Every element they list in the
 * example screenshot is present on this page; see ConsentForm for
 * the form rendering itself.
 *
 * Async server component so MarketingNav gets the right CTA for
 * the visitor's auth state (matches landing/privacy/terms pattern).
 */

import { auth } from '@clerk/nextjs/server';
import MarketingNav from '@/components/marketing/MarketingNav';
import ConsentForm from './ConsentForm';

export const metadata = {
  title:       'SMS Subscription · FleetCal',
  description: 'Opt in to receive transactional SMS from FleetCal about dispatch operations.',
};

type AuthCta = 'out' | 'mid-signup' | 'in';
function ctaFor(state: AuthCta): { href: string; label: string } {
  if (state === 'in')         return { href: '/calendar', label: 'Open FleetCal →' };
  if (state === 'mid-signup') return { href: '/sign-up',  label: 'Continue setup →' };
  return                              { href: '/sign-up',  label: 'Start free trial' };
}

export default async function SmsConsentPage() {
  const { userId, orgId } = await auth();
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{ scrollBehavior: 'smooth' }}>
      <MarketingNav cta={cta} showSignIn={state === 'out'} />
      <main style={{
        maxWidth:   860,
        margin:     '0 auto',
        padding:    '48px 24px 96px',
        fontFamily: 'var(--font-jakarta), system-ui, sans-serif',
        color:      '#202124',
        lineHeight: 1.65,
      }}>
        <header style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>
            Subscribe to FleetCal SMS
          </h1>
          <p style={{ fontSize: 15, color: '#5f6368', marginTop: 8, maxWidth: 540, marginLeft: 'auto', marginRight: 'auto' }}>
            Drivers can opt in here to receive dispatch text messages from FleetCal — load assignments,
            schedule changes, pickup and delivery reminders, and account verification codes.
          </p>
        </header>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ConsentForm />
        </div>

        <p style={{
          maxWidth:  420,
          margin:    '24px auto 0',
          textAlign: 'center',
          fontSize:  12,
          color:     '#5f6368',
        }}>
          Operated by Systematica Solutions LLC. By submitting, you confirm you are the owner of the phone
          number above and authorized to subscribe it to FleetCal SMS.
        </p>
      </main>
    </div>
  );
}
