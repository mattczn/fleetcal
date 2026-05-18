/**
 * Privacy Policy — public page. Linked from the Twilio A2P 10DLC
 * registration as the required Privacy Policy URL. Hosted at /privacy
 * (public route in middleware.ts).
 */
export const metadata = {
  title:       'Privacy Policy — Curzon Trucking',
  description: 'How Curzon Trucking collects, uses, and protects driver and dispatcher information.',
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px', color: '#202124', lineHeight: 1.65, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8, letterSpacing: '-0.02em' }}>Privacy Policy</h1>
      <p style={{ color: '#5f6368', fontSize: 14, marginBottom: 32 }}>Last updated: May 18, 2026</p>

      <section style={section}>
        <h2 style={h2}>Who we are</h2>
        <p>Curzon Trucking ("we", "us") operates FleetCal — a dispatch and driver-app platform used internally by our employees, contractors, and authorized partners. This policy describes what data we collect through our web app and mobile apps and how we use it.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>What we collect</h2>
        <ul style={ul}>
          <li><strong>Account information:</strong> name, email, phone number, role, organization assignment.</li>
          <li><strong>Driver information:</strong> CDL number and state, license expiration, medical card expiration, date of birth, mailing address, employment-related notes.</li>
          <li><strong>Mobile device data:</strong> push notification token, device platform, periodic device check-in time. The driver mobile app requests location access only when the driver explicitly checks in at a stop; the recorded coordinates are used to confirm arrival and support detention claims.</li>
          <li><strong>Operational data:</strong> load assignments, stop check-ins, status updates, uploaded documents (POD, BOL, scale tickets, etc.), audit log of changes.</li>
          <li><strong>Authentication data:</strong> when a driver signs in to the mobile app, we send a one-time SMS verification code to the phone number on file. We do not store the code beyond verification; we record the time of successful sign-in for audit purposes.</li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={h2}>How we use it</h2>
        <ul style={ul}>
          <li>Verify the identity of drivers and dispatchers signing in to our systems.</li>
          <li>Coordinate load assignments, communicate route information, and document the chain of custody for freight.</li>
          <li>Send transactional notifications: new load assignments, pickup reminders, missing-paperwork nudges. Drivers can opt out of any auto-fired category from the Notifications screen in the mobile app.</li>
          <li>Generate operational reports, invoices, and payroll records for the org.</li>
          <li>Comply with applicable transportation, employment, and tax regulations.</li>
        </ul>
      </section>

      <section style={section}>
        <h2 style={h2}>SMS messaging</h2>
        <p>We use SMS (text message) for one-time verification codes when a driver signs in to the mobile app, and (optionally) for the same notifications listed above. Message frequency varies by your activity. Message and data rates may apply. Reply <strong>STOP</strong> to any of our messages to unsubscribe; reply <strong>HELP</strong> for help. Mobile carriers are not liable for delayed or undelivered messages.</p>
        <p>We do not share SMS opt-in data or phone numbers with third parties for marketing purposes. Phone numbers and consent records are used solely to deliver the messages described above.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>Who can see your data</h2>
        <ul style={ul}>
          <li><strong>You</strong> — drivers can view and update their own profile, documents, and notification preferences from the mobile app.</li>
          <li><strong>Authorized dispatchers and administrators</strong> within your organization, scoped by role.</li>
          <li><strong>Service providers we rely on</strong> to operate the platform: Supabase (database + storage), Clerk (web sign-in), Twilio (SMS), Expo (push notifications), Google Maps (routing + geocoding), and our infrastructure hosts (Vercel, Railway). Each is bound by their own privacy and security commitments and may only use the data to provide their service to us.</li>
          <li><strong>Government and regulatory bodies</strong> when required by law (e.g. DOT audits, subpoenas).</li>
        </ul>
        <p>We do not sell your personal information.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>Data retention</h2>
        <p>Operational records (loads, documents, audit logs) are retained for as long as required by federal and state transportation and tax record-keeping rules — typically a minimum of 3 years, longer for certain categories. Driver profile data is retained for the duration of the employment or contracting relationship and for any record-keeping period after it ends. You may request a copy of your data or its deletion at any time by emailing the address below.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>Security</h2>
        <p>Data is transmitted over HTTPS, stored on managed cloud infrastructure with at-rest encryption, and access is gated by per-role permissions in the app. Authentication uses one-time codes (SMS for drivers) and federated identity (for dispatchers); we never store user passwords.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>Your rights</h2>
        <p>Depending on where you live, you may have the right to: access the personal information we hold about you, correct inaccuracies, request deletion, and object to certain uses. To exercise any of these rights, email the address below.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>Contact</h2>
        <p>Questions about this policy or your data: <a href="mailto:curzondispatch2@gmail.com" style={link}>curzondispatch2@gmail.com</a>.</p>
      </section>

      <hr style={{ margin: '32px 0', border: 0, borderTop: '1px solid #e8eaed' }} />
      <p style={{ fontSize: 13, color: '#5f6368' }}>
        See also: <a href="/terms" style={link}>Terms of Service</a>.
      </p>
    </main>
  );
}

const section: React.CSSProperties = { marginBottom: 28 };
const h2: React.CSSProperties = { fontSize: 18, fontWeight: 700, marginBottom: 8, color: '#202124' };
const ul: React.CSSProperties = { paddingLeft: 22, margin: 0 };
const link: React.CSSProperties = { color: '#1a73e8', textDecoration: 'underline' };
