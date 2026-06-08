/**
 * Terms of Service — publicly accessible at /terms.
 *
 * Includes an SMS Messaging Terms section that mirrors the
 * disclosures in /privacy and meets A2P 10DLC carrier-vetting
 * requirements (opt-in, opt-out, frequency, "msg & data rates
 * may apply", HELP).
 *
 * THIS IS NOT LEGAL ADVICE. Have an attorney review before going
 * live.
 *
 * Async server component so MarketingNav gets the right CTA for
 * the visitor's auth state.
 */

import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import MarketingNav from '@/components/marketing/MarketingNav';

export const metadata = {
  title:       'Terms of Service · FleetCal',
  description: 'Terms governing your use of the FleetCal trucking dispatch platform.',
};

const EFFECTIVE_DATE = 'June 8, 2026';
const LEGAL_ENTITY   = 'Systematica Solutions LLC';
const STATE          = 'Florida';
const CONTACT_EMAIL  = 'hello@fleetcal.app';

type AuthCta = 'out' | 'mid-signup' | 'in';
function ctaFor(state: AuthCta): { href: string; label: string } {
  if (state === 'in')         return { href: '/calendar', label: 'Open FleetCal →' };
  if (state === 'mid-signup') return { href: '/sign-up',  label: 'Continue setup →' };
  return                              { href: '/sign-up',  label: 'Start free trial' };
}

export default async function TermsOfService() {
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
      <header style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 36, fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>Terms of Service</h1>
        <p style={{ fontSize: 14, color: '#5f6368', marginTop: 8 }}>
          Effective {EFFECTIVE_DATE}. Last updated {EFFECTIVE_DATE}.
        </p>
      </header>

      <section>
        <p>
          These Terms of Service (the &ldquo;Terms&rdquo;) govern your access to and use of the FleetCal
          trucking dispatch and fleet management platform at <Link href="/">fleetcal.app</Link> and any related
          services (collectively, the &ldquo;Service&rdquo;), operated by {LEGAL_ENTITY} (&ldquo;FleetCal&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;).
        </p>
        <p>
          <strong>By creating an account or using the Service, you agree to these Terms and to our{' '}
          <Link href="/privacy">Privacy Policy</Link>.</strong> If you are using the Service on behalf of an
          organization, you represent that you have authority to bind that organization to these Terms.
        </p>
      </section>

      <H2>1. Eligibility &amp; Accounts</H2>
      <p>
        You must be at least 18 years old and able to enter into a binding contract to use the Service. You agree
        to provide accurate, current, and complete information when you register and to keep that information
        up to date. You are responsible for all activity that occurs under your account and for keeping your
        login credentials confidential.
      </p>

      <H2>2. Subscriptions, Billing &amp; Trials</H2>
      <p>
        The Service is offered as a paid subscription. Fees, included truck counts, and billing intervals are
        described on our <Link href="/#pricing">pricing page</Link> at the time of purchase. Subscriptions
        renew automatically at the end of each billing period unless cancelled. You may cancel at any time
        through your account settings; cancellation takes effect at the end of the current billing period.
      </p>
      <p>
        All fees are non-refundable except where required by law. We may change our prices on prospective
        billing periods with at least 30 days&rsquo; notice.
      </p>

      <H2>3. Your Content &amp; License to Us</H2>
      <p>
        You retain all rights to the data you submit to the Service (loads, customers, brokers, equipment,
        drivers, documents, etc.) (&ldquo;Customer Content&rdquo;). You grant us a worldwide, non-exclusive,
        royalty-free license to host, process, transmit, display, and modify Customer Content solely as needed
        to provide the Service to you.
      </p>
      <p>
        You are responsible for the lawfulness and accuracy of your Customer Content and for obtaining all
        consents required to share third-party information (including driver phone numbers, customer contact
        information, and any personal data of others) with us.
      </p>

      <H2>4. Acceptable Use</H2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service to violate any law, regulation, or third-party right.</li>
        <li>Upload malware, viruses, or any content that could harm the Service or its users.</li>
        <li>Attempt to bypass authentication, rate limits, billing caps, or other security measures.</li>
        <li>Scrape, mirror, or reverse-engineer the Service, except as expressly permitted by law.</li>
        <li>Send unsolicited bulk communications (SPAM) through the Service.</li>
        <li>Use the Service to send SMS to recipients who have not consented or who have opted out.</li>
        <li>Misrepresent your identity or affiliation with any person or organization.</li>
      </ul>

      <H2>5. SMS Messaging Terms</H2>
      <p style={HIGHLIGHT_BOX}>
        <strong>No mobile information will be shared with third parties or affiliates for marketing or
        promotional purposes.</strong>
      </p>
      <p>
        If you enable SMS notifications, the following terms apply to you and to your drivers and recipients
        (collectively, &ldquo;Subscribers&rdquo;):
      </p>
      <ul>
        <li><strong>Program description.</strong> FleetCal sends transactional SMS messages including load assignments, dispatch updates, pickup/delivery reminders, schedule changes, and verification codes.</li>
        <li><strong>Consent.</strong> Subscribers must consent before receiving SMS. As an organization administrator, you represent that every phone number you submit belongs to a Subscriber who has consented to receive SMS from your organization through FleetCal.</li>
        <li><strong>Frequency.</strong> Message frequency varies based on dispatch activity.</li>
        <li><strong>Cost.</strong> Message and data rates may apply. Subscribers should contact their wireless carrier for plan details.</li>
        <li><strong>Opt-out.</strong> Subscribers may reply <strong>STOP</strong> to any message to stop receiving SMS. After replying STOP, the Subscriber will receive one confirmation message and no further SMS until they re-subscribe.</li>
        <li><strong>Help.</strong> Subscribers may reply <strong>HELP</strong> for assistance or contact us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</li>
        <li><strong>Supported carriers.</strong> Major U.S. carriers including AT&amp;T, T-Mobile, Verizon, and others. Carriers are not liable for delayed or undelivered messages.</li>
      </ul>
      <p>
        You agree to indemnify FleetCal against any claim, fine, or penalty arising from your failure to obtain
        the required consents from Subscribers before submitting their phone numbers to the Service.
      </p>

      <H2>6. Third-Party Services &amp; Integrations</H2>
      <p>
        The Service integrates with third-party services (such as Motive ELDs, Google Maps, payment processors,
        and email/SMS gateways). Your use of those services is subject to the third party&rsquo;s own terms and
        privacy policies. We are not responsible for third-party services, and their availability is not
        guaranteed.
      </p>

      <H2>7. Intellectual Property</H2>
      <p>
        The Service, including its software, design, and content (other than Customer Content), is owned by
        FleetCal and protected by intellectual-property laws. We grant you a limited, revocable, non-exclusive,
        non-transferable license to use the Service for your internal business purposes during your active
        subscription.
      </p>

      <H2>8. Suspension &amp; Termination</H2>
      <p>
        We may suspend or terminate your access to the Service if you breach these Terms, if your account is
        delinquent, or if we reasonably believe your use is harming the Service or other users. You may
        terminate by closing your account at any time. Upon termination, you will lose access to the Service
        and your Customer Content may be deleted after a reasonable retention period.
      </p>

      <H2>9. Disclaimer of Warranties</H2>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND,
        WHETHER EXPRESS, IMPLIED, OR STATUTORY. WE DISCLAIM ALL WARRANTIES INCLUDING MERCHANTABILITY, FITNESS FOR
        A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED,
        SECURE, OR ERROR-FREE.
      </p>

      <H2>10. Limitation of Liability</H2>
      <p>
        TO THE FULLEST EXTENT PERMITTED BY LAW, IN NO EVENT WILL FLEETCAL BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
        SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, OR DATA. OUR TOTAL
        LIABILITY UNDER THESE TERMS WILL NOT EXCEED THE AMOUNT YOU PAID US IN THE TWELVE (12) MONTHS BEFORE THE
        EVENT GIVING RISE TO THE CLAIM.
      </p>

      <H2>11. Indemnification</H2>
      <p>
        You will indemnify, defend, and hold harmless FleetCal from and against any third-party claim arising
        from your Customer Content, your use of the Service, your breach of these Terms, or your violation of
        any law or third-party right (including SMS-related claims under the TCPA or similar statutes).
      </p>

      <H2>12. Governing Law &amp; Dispute Resolution</H2>
      <p>
        These Terms are governed by the laws of the State of {STATE}, without regard to its conflict-of-laws
        rules. Any dispute will be resolved exclusively in the state or federal courts located in {STATE}, and
        you and FleetCal each consent to the personal jurisdiction of those courts.
      </p>

      <H2>13. Changes to These Terms</H2>
      <p>
        We may update these Terms from time to time. When we do, we will revise the &ldquo;Last updated&rdquo;
        date at the top. If changes are material, we will provide additional notice (in-product banner or email)
        before they take effect. Your continued use of the Service after the changes take effect constitutes
        acceptance of the new Terms.
      </p>

      <H2>14. Contact</H2>
      <p style={CONTACT_BOX}>
        <strong>{LEGAL_ENTITY}</strong><br />
        Email: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a><br />
        State of formation: {STATE}, United States
      </p>

      <FooterNav />
      </main>
    </div>
  );
}

const HIGHLIGHT_BOX: React.CSSProperties = {
  background:   '#f1f3f4',
  border:       '1px solid #e8eaed',
  padding:      '16px 18px',
  borderRadius: 8,
  margin:       '16px 0 24px',
  fontSize:     15,
};

const CONTACT_BOX: React.CSSProperties = {
  background:   '#f8f9fa',
  border:       '1px solid #e8eaed',
  padding:      '16px 18px',
  borderRadius: 8,
  margin:       '16px 0 24px',
  fontSize:     14,
};

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize:      22,
      fontWeight:    700,
      marginTop:     40,
      marginBottom:  12,
      letterSpacing: '-0.005em',
      color:         '#202124',
    }}>{children}</h2>
  );
}

function FooterNav() {
  return (
    <nav style={{
      marginTop:    64,
      paddingTop:   24,
      borderTop:    '1px solid #e8eaed',
      display:      'flex',
      gap:          20,
      fontSize:     14,
      color:        '#5f6368',
    }}>
      <Link href="/" style={{ color: '#5f6368' }}>← Back to FleetCal</Link>
      <Link href="/privacy" style={{ color: '#5f6368' }}>Privacy Policy</Link>
    </nav>
  );
}
