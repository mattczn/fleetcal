/**
 * Privacy Policy — publicly accessible at /privacy.
 *
 * Drafted to meet A2P 10DLC carrier compliance requirements for
 * SMS sending — the SMS section uses the exact magic phrase
 * "no mobile information will be shared with third parties for
 * marketing/promotional purposes" that AT&T, T-Mobile, and Verizon
 * scan for during brand/campaign registration.
 *
 * THIS IS NOT LEGAL ADVICE. Have an attorney review before going
 * live. Placeholders to fill in:
 *   - [LEGAL ENTITY NAME]        ← your registered LLC / corp name
 *   - [STATE OF INCORPORATION]   ← default: Utah
 *   - privacy@fleetcal.app       ← swap if you use a different inbox
 *   - Effective date below       ← set when you publish for real
 */

import Link from 'next/link';
import Image from 'next/image';

export const metadata = {
  title:       'Privacy Policy · FleetCal',
  description: 'How FleetCal collects, uses, and protects your information — including SMS messaging consent and opt-out.',
};

const EFFECTIVE_DATE = 'June 8, 2026';
const LEGAL_ENTITY   = '[LEGAL ENTITY NAME]';
const STATE          = 'Utah';
const PRIVACY_EMAIL  = 'privacy@fleetcal.app';

export default function PrivacyPolicy() {
  return (
    <main style={{
      maxWidth:   860,
      margin:     '0 auto',
      padding:    '48px 24px 96px',
      fontFamily: 'var(--font-jakarta), system-ui, sans-serif',
      color:      '#202124',
      lineHeight: 1.65,
    }}>
      <header style={{ marginBottom: 40 }}>
        <Link href="/" style={{ display: 'inline-block', marginBottom: 24 }}>
          <Image src="/logo-horizontal.png" alt="FleetCal" width={140} height={32}
            style={{ height: 32, width: 'auto' }} />
        </Link>
        <h1 style={{ fontSize: 36, fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>Privacy Policy</h1>
        <p style={{ fontSize: 14, color: '#5f6368', marginTop: 8 }}>
          Effective {EFFECTIVE_DATE}. Last updated {EFFECTIVE_DATE}.
        </p>
      </header>

      <section>
        <p>
          {LEGAL_ENTITY} (&ldquo;FleetCal&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;) operates the
          FleetCal trucking dispatch and fleet management platform at <Link href="/">fleetcal.app</Link> (the
          &ldquo;Service&rdquo;). This Privacy Policy explains what information we collect when you or your
          drivers use the Service, how we use it, and the rights you have.
        </p>
        <p>
          By using the Service, you agree to the practices described in this Policy. If you do not agree, please
          do not use the Service.
        </p>
      </section>

      <H2>1. Information We Collect</H2>
      <p>We collect the following categories of information:</p>
      <h3 style={H3}>Account information</h3>
      <ul>
        <li>Your name, email address, phone number, and password (managed by our authentication provider).</li>
        <li>Your organization name, billing address, and payment information (processed by our payment provider).</li>
      </ul>
      <h3 style={H3}>Dispatch and operational data you submit</h3>
      <ul>
        <li>Loads, customers, brokers, equipment, drivers, trailers, routes, locations, and uploaded documents (rate cons, POD scans, invoices, etc.).</li>
        <li>Driver names, phone numbers, license details, and assignment history.</li>
        <li>Geolocation data from connected ELD providers (e.g. Motive) for trucks and drivers you have authorized to share with us.</li>
      </ul>
      <h3 style={H3}>Communications</h3>
      <ul>
        <li>SMS and email messages we send to you or your drivers, and your replies (see SMS section below).</li>
        <li>Support requests and feedback you submit.</li>
      </ul>
      <h3 style={H3}>Usage and device information</h3>
      <ul>
        <li>Pages visited, features used, timestamps, IP address, browser, operating system, and device identifiers.</li>
        <li>Error reports and performance telemetry (collected via Sentry) to help us diagnose bugs.</li>
      </ul>

      <H2>2. How We Use Information</H2>
      <ul>
        <li>To provide, operate, and maintain the Service.</li>
        <li>To send SMS and email notifications to dispatchers and drivers about loads, schedule changes, and confirmations they have opted in to receive.</li>
        <li>To process payments and manage subscriptions.</li>
        <li>To detect, prevent, and respond to fraud, abuse, security incidents, and unauthorized activity.</li>
        <li>To improve the Service, including diagnosing errors and analyzing aggregated usage.</li>
        <li>To comply with legal obligations and enforce our <Link href="/terms">Terms of Service</Link>.</li>
      </ul>

      <H2>3. SMS Messaging Program</H2>
      <p style={{ ...HIGHLIGHT_BOX }}>
        <strong>No mobile information will be shared with third parties or affiliates for marketing or promotional
        purposes.</strong> All categories of personal information&mdash;including mobile phone numbers and the
        contents of SMS messages&mdash;are excluded from any sharing with third parties for those purposes. The
        only sharing of mobile information described below is with subprocessors strictly necessary to deliver the
        messages you have asked us to send.
      </p>

      <h3 style={H3}>What messages we send</h3>
      <p>
        When you or your organization adds a driver, contact, or recipient to FleetCal and grants consent, we may
        send transactional SMS messages such as: load assignment notifications, dispatch updates, pickup/delivery
        reminders, schedule changes, account verification codes, and password resets.
      </p>
      <h3 style={H3}>How recipients consent</h3>
      <p>
        Recipients consent to receive SMS messages either (a) by signing up for an account and providing their
        mobile number, (b) by being added by their dispatcher with their permission, or (c) by replying to a
        one-time opt-in prompt sent during account setup. We do not send SMS marketing.
      </p>
      <h3 style={H3}>Frequency &amp; cost</h3>
      <p>
        Message frequency varies based on dispatch activity. <strong>Message and data rates may apply.</strong>
        Frequency is typically less than 10 messages per day per driver but can be higher during active dispatch.
      </p>
      <h3 style={H3}>Opting out</h3>
      <p>
        You can opt out of SMS at any time by replying <strong>STOP</strong> to any message. After replying STOP,
        you will receive one confirmation message and then no further SMS. To resume, reply <strong>START</strong>
        or contact us at <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>. For help, reply
        <strong> HELP</strong> or email us.
      </p>
      <h3 style={H3}>Subprocessors used for SMS delivery</h3>
      <p>
        We use third-party SMS gateways (such as Twilio) to deliver messages. These providers receive your phone
        number and the message contents <em>solely</em> to deliver the message. They are contractually bound not
        to use this information for any other purpose, including marketing.
      </p>

      <H2>4. How We Share Information</H2>
      <p>We share information only as follows:</p>
      <ul>
        <li><strong>Subprocessors and service providers</strong> who perform services on our behalf, including hosting (Vercel, Railway), database (Supabase), authentication (Clerk), payment processing, email/SMS delivery, error monitoring (Sentry), and AI processing (Anthropic). Each is bound by contractual confidentiality and data-processing obligations.</li>
        <li><strong>Within your organization.</strong> Information you submit to your organization&rsquo;s account (loads, customers, drivers, documents) is visible to other authorized users in that organization based on their role.</li>
        <li><strong>Legal compliance.</strong> When required by law, subpoena, court order, or to protect rights, property, or safety.</li>
        <li><strong>Business transfers.</strong> If we are involved in a merger, acquisition, or asset sale, your information may be transferred as part of that transaction. You will be notified before your information becomes subject to a different privacy policy.</li>
      </ul>
      <p>
        <strong>We do not sell or rent your personal information, and we do not share mobile phone numbers or SMS
        contents with third parties for marketing.</strong>
      </p>

      <H2>5. Data Retention</H2>
      <p>
        We retain account, dispatch, and load data for as long as your organization maintains an active account
        with us, plus a reasonable period thereafter to comply with legal, tax, and audit obligations. You may
        request deletion of specific records at any time through the Service or by emailing us.
      </p>

      <H2>6. Security</H2>
      <p>
        We use industry-standard technical and organizational measures to protect your information, including
        encryption in transit (HTTPS/TLS), encryption at rest, access controls, audit logging, and least-privilege
        infrastructure. No system is perfectly secure, however, and you use the Service at your own risk.
      </p>

      <H2>7. Your Rights</H2>
      <p>
        Depending on where you live, you may have rights to access, correct, delete, port, or restrict our
        processing of your information. To exercise these rights, email us at
        <a href={`mailto:${PRIVACY_EMAIL}`}> {PRIVACY_EMAIL}</a>. We will respond within the time required by
        applicable law.
      </p>
      <p>
        <strong>California residents (CCPA/CPRA):</strong> You have the right to know what categories of personal
        information we collect, the right to request deletion, the right to correct inaccurate information, the
        right to opt out of any &ldquo;sale&rdquo; or &ldquo;sharing&rdquo; (we do not sell or share personal
        information as those terms are defined under California law), and the right not to receive discriminatory
        treatment for exercising these rights.
      </p>

      <H2>8. Children</H2>
      <p>
        The Service is not directed to and is not intended for use by anyone under 18. We do not knowingly
        collect personal information from children under 18. If you believe we have collected such information,
        please contact us so we can delete it.
      </p>

      <H2>9. International Users</H2>
      <p>
        FleetCal is operated from the United States. If you access the Service from outside the U.S., your
        information will be transferred to, stored in, and processed in the United States.
      </p>

      <H2>10. Changes to This Policy</H2>
      <p>
        We may update this Policy from time to time. When we do, we will revise the &ldquo;Last updated&rdquo;
        date at the top. If changes are material, we will provide additional notice (such as an in-product banner
        or email) before the changes take effect.
      </p>

      <H2>11. Contact Us</H2>
      <p>
        Questions about this Policy or about your information? Contact:
      </p>
      <p style={CONTACT_BOX}>
        <strong>{LEGAL_ENTITY}</strong><br />
        Attn: Privacy<br />
        Email: <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a><br />
        State of formation: {STATE}, United States
      </p>

      <FooterNav />
    </main>
  );
}

const H3: React.CSSProperties = {
  fontSize:    16,
  fontWeight:  700,
  marginTop:   24,
  marginBottom: 8,
  color:        '#202124',
};

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
      fontSize:     22,
      fontWeight:   700,
      marginTop:    40,
      marginBottom: 12,
      letterSpacing: '-0.005em',
      color:        '#202124',
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
      <Link href="/terms" style={{ color: '#5f6368' }}>Terms of Service</Link>
    </nav>
  );
}
