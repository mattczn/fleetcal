/**
 * Terms of Service — public page. Linked from the Twilio A2P 10DLC
 * registration as the required Terms URL. Hosted at /terms (public
 * route in middleware.ts).
 */
export const metadata = {
  title:       'Terms of Service — Curzon Trucking',
  description: 'Terms governing use of the FleetCal dispatch and driver platform.',
};

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px', color: '#202124', lineHeight: 1.65, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8, letterSpacing: '-0.02em' }}>Terms of Service</h1>
      <p style={{ color: '#5f6368', fontSize: 14, marginBottom: 32 }}>Last updated: May 18, 2026</p>

      <section style={section}>
        <h2 style={h2}>1. Who these terms apply to</h2>
        <p>These terms govern your use of FleetCal — the dispatch web app and driver mobile app operated by Curzon Trucking ("we", "us"). They apply to all employees, contractors, and authorized agents granted access to either app.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>2. Authorized use</h2>
        <p>You may use FleetCal only as part of your work for Curzon Trucking, in accordance with any role and permissions assigned to your account. You may not share your account credentials, attempt to access data outside your role's scope, or use the system to send messages or store data unrelated to authorized business activity.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>3. SMS messaging</h2>
        <p>By signing in to the FleetCal driver mobile app with your phone number, you consent to receive automated SMS verification codes at that number whenever you initiate sign-in. You may also receive automated SMS or push notifications related to load assignments, pickup reminders, and missing-paperwork follow-ups, subject to your notification preferences inside the app.</p>
        <p>Message frequency varies based on your activity and your organization's settings. Standard message and data rates may apply. Reply <strong>STOP</strong> to opt out of all SMS from us at any time. Reply <strong>HELP</strong> to receive support information. For full details on what data we collect and how it's used, see our <a href="/privacy" style={link}>Privacy Policy</a>.</p>
        <p>If you reply STOP, you will continue to be able to use the mobile app, but you will need to obtain sign-in verification codes through an alternative channel (contact your dispatcher).</p>
      </section>

      <section style={section}>
        <h2 style={h2}>4. Data accuracy</h2>
        <p>You agree to keep your contact information current and to use the app to record load events (pickups, deliveries, exceptions) accurately and promptly. The audit log retains a record of changes you make for compliance purposes.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>5. Documents you upload</h2>
        <p>You retain whatever ownership rights you have in documents you upload (PODs, BOLs, scale tickets, receipts, etc.). You grant Curzon Trucking the right to store, transmit, and process those documents in support of normal operations and required record-keeping.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>6. Service availability</h2>
        <p>We work to keep FleetCal available but do not guarantee uninterrupted service. Maintenance windows, third-party outages (cloud providers, SMS carriers, push notification services), and unforeseen incidents may affect availability. Critical operational decisions should not rely solely on the app's availability.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>7. Termination</h2>
        <p>Access to FleetCal is tied to your role with Curzon Trucking. When that role ends, your access will be revoked. We may also suspend access for violations of these terms or applicable law.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>8. Changes to these terms</h2>
        <p>We may update these terms from time to time. Material changes will be communicated through the app or by direct notice; continued use after the effective date constitutes acceptance.</p>
      </section>

      <section style={section}>
        <h2 style={h2}>9. Contact</h2>
        <p>Questions about these terms: <a href="mailto:curzondispatch2@gmail.com" style={link}>curzondispatch2@gmail.com</a>.</p>
      </section>

      <hr style={{ margin: '32px 0', border: 0, borderTop: '1px solid #e8eaed' }} />
      <p style={{ fontSize: 13, color: '#5f6368' }}>
        See also: <a href="/privacy" style={link}>Privacy Policy</a>.
      </p>
    </main>
  );
}

const section: React.CSSProperties = { marginBottom: 28 };
const h2: React.CSSProperties = { fontSize: 18, fontWeight: 700, marginBottom: 8, color: '#202124' };
const link: React.CSSProperties = { color: '#1a73e8', textDecoration: 'underline' };
