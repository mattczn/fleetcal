/**
 * /support — public "Contact us" page.
 *
 * This is the Support URL surfaced to the App Store / Play Store for the
 * FleetCal Driver and FleetCal Go apps, and linked from the marketing
 * footer. A simple contact form (name, email, topic, message) that POSTs
 * to the API's /v1/support endpoint, which emails SUPPORT_TO
 * (defaults to hello@fleetcal.app) via Resend.
 *
 * Mirrors the /contact-sales design + anti-spam (hidden honeypot input +
 * loaded-at timestamp, both enforced server-side). Reuses the same form
 * primitives and Systematica-style chrome so it reads as one site.
 */
'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import MarketingNav from '@/components/marketing/MarketingNav';
import { ArrowRight, Check, Loader2, Mail, Clock } from 'lucide-react';

const API_BASE =
  process.env.NEXT_PUBLIC_RAILWAY_URL ?? 'https://fleetcalapi-production.up.railway.app';

const CTA = { href: '/sign-up', label: 'Try for free' };

const SUPPORT_EMAIL = 'hello@fleetcal.app';

const TOPICS = [
  'Driver app (mobile)',
  'Dispatcher web app',
  'Billing & account',
  'Something else',
] as const;

interface SupportForm {
  name:    string;
  email:   string;
  topic:   string;
  message: string;
}

export default function SupportPage() {
  const [form, setForm] = useState<SupportForm>({
    name: '', email: '', topic: '', message: '',
  });
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent]   = useState(false);

  // Anti-spam: hidden honeypot + a "page loaded at" stamp. A real person
  // can't read + fill the form in under 2s; a bot can. Both checked server-side.
  const honeypotRef = useRef<HTMLInputElement | null>(null);
  const [loadedAt]  = useState(() => Date.now());

  useEffect(() => {
    document.title = 'Support · FleetCal';
  }, []);

  function update<K extends keyof SupportForm>(key: K, value: SupportForm[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const name    = form.name.trim();
    const email   = form.email.trim();
    const message = form.message.trim();
    if (!name)    { setError('Please add your name.');  return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please add a valid email so we can reply.'); return;
    }
    if (!message) { setError('Please tell us how we can help.'); return; }

    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/v1/support`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          topic:   form.topic.trim(),
          message,
          website:  honeypotRef.current?.value ?? '',
          loadedAt,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.error === 'email_not_configured') {
          setError(`Our form is briefly unavailable — please email ${SUPPORT_EMAIL} directly.`);
        } else {
          setError('Something went wrong sending your message. Please try again, or email us directly.');
        }
        setBusy(false);
        return;
      }
      setSent(true);
    } catch {
      setError('Network error. Please try again, or email us directly.');
      setBusy(false);
    }
  }

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <MarketingNav cta={CTA} showSignIn />

      <section style={{ padding: '56px 20px 80px' }}>
        <div style={{ maxWidth: 620, margin: '0 auto' }}>

          {/* Heading */}
          <div className="text-center" style={{ marginBottom: 28 }}>
            <h1 className="font-display" style={{
              fontWeight: 800, fontSize: 'clamp(28px, 4vw, 40px)',
              lineHeight: 1.1, letterSpacing: '-0.02em', color: '#202124', margin: 0,
            }}>
              How can we help?
            </h1>
            <p style={{ fontSize: 16, color: '#5f6368', margin: '12px auto 0', maxWidth: 480 }}>
              Question, bug, or feedback on the FleetCal apps? Send us a note —
              we&apos;re a small team and we read every one.
            </p>
          </div>

          {/* Quick facts */}
          {!sent && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
              gap: 10, marginBottom: 24,
            }}>
              <InfoChip icon={<Mail size={14} />}>
                <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none' }}>
                  {SUPPORT_EMAIL}
                </a>
              </InfoChip>
              <InfoChip icon={<Clock size={14} />}>
                Replies within 1 business day
              </InfoChip>
            </div>
          )}

          {/* Card */}
          <div style={{
            background:   '#fff',
            border:       '1px solid #e8eaed',
            borderRadius: 24,
            boxShadow:    'var(--shadow-soft)',
            padding:      '32px 28px',
          }}>
            {sent ? (
              <SuccessPanel email={form.email.trim()} />
            ) : (
              <form onSubmit={submit} className="grid gap-4">
                {/* Honeypot — visually hidden, real users never fill it */}
                <div className="absolute -left-[9999px] overflow-hidden" aria-hidden="true">
                  <input ref={honeypotRef} type="text" name="website" tabIndex={-1} autoComplete="off" />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="Your name *">
                    <input
                      style={inputStyle}
                      value={form.name}
                      onChange={e => update('name', e.target.value)}
                      placeholder="Jane Driver"
                    />
                  </Field>
                  <Field label="Email *">
                    <input
                      type="email"
                      style={inputStyle}
                      value={form.email}
                      onChange={e => update('email', e.target.value)}
                      placeholder="you@yourfleet.com"
                    />
                  </Field>
                </div>

                <Field label="What's this about?">
                  <select
                    style={{ ...inputStyle, appearance: 'none', cursor: 'pointer' }}
                    value={form.topic}
                    onChange={e => update('topic', e.target.value)}
                  >
                    <option value="">Choose a topic (optional)</option>
                    {TOPICS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>

                <Field label="How can we help? *">
                  <textarea
                    rows={5}
                    style={inputStyle}
                    value={form.message}
                    onChange={e => update('message', e.target.value)}
                    placeholder="Tell us what's going on. If it's a bug, what were you doing when it happened?"
                  />
                </Field>

                {error && (
                  <div style={{
                    background: '#fce8e6', color: '#a50e0e', border: '1px solid #f5c2c0',
                    borderRadius: 10, padding: '10px 14px', fontSize: 14,
                  }}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="font-display inline-flex items-center justify-center"
                  style={{
                    background:   'var(--gc-blue)',
                    color:        '#fff',
                    fontWeight:   600,
                    fontSize:     16,
                    padding:      '14px 24px',
                    borderRadius: 999,
                    border:       'none',
                    cursor:       busy ? 'default' : 'pointer',
                    opacity:      busy ? 0.7 : 1,
                    transition:   'opacity .15s, background .15s',
                    gap:          8,
                    marginTop:    2,
                  }}
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  {busy ? 'Sending…' : 'Send message'}
                </button>
              </form>
            )}
          </div>

          {/* Legal / footer line */}
          <p className="text-center" style={{ fontSize: 13, color: '#5f6368', marginTop: 22 }}>
            By contacting us you agree to our{' '}
            <Link href="/privacy" style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none' }}>Privacy Policy</Link>
            {' '}and{' '}
            <Link href="/terms" style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none' }}>Terms</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function SuccessPanel({ email }: { email: string }) {
  return (
    <div className="text-center" style={{ padding: '20px 0' }}>
      <div style={{
        width: 56, height: 56, borderRadius: 999, background: '#e6f4ea',
        margin: '0 auto 14px', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Check size={26} strokeWidth={3} style={{ color: '#1e8e3e' }} />
      </div>
      <h2 className="font-display" style={{
        fontWeight: 800, fontSize: 'clamp(22px, 2.6vw, 28px)',
        lineHeight: 1.2, letterSpacing: '-0.012em', color: '#202124', margin: 0,
      }}>
        Message sent. Thank you.
      </h2>
      <p style={{ fontSize: 15, color: '#5f6368', margin: '10px auto 0', maxWidth: 420 }}>
        We&apos;ll get back to you within one business day{email ? <> at <strong style={{ color: '#3c4043' }}>{email}</strong></> : ''}.
        Often much faster.
      </p>
      <Link
        href="/"
        className="font-display inline-flex items-center justify-center"
        style={{
          background: 'var(--gc-blue)', color: '#fff', fontWeight: 600,
          fontSize: 15, padding: '12px 22px', borderRadius: 999,
          textDecoration: 'none', marginTop: 20, gap: 8,
        }}
      >
        Back to home <ArrowRight size={15} />
      </Link>
    </div>
  );
}

function InfoChip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 7,
      background: '#f8f9fa', border: '1px solid #e8eaed', borderRadius: 999,
      padding: '7px 14px', fontSize: 13.5, color: '#3c4043', fontWeight: 500,
    }}>
      <span style={{ color: '#5f6368', display: 'inline-flex' }}>{icon}</span>
      {children}
    </span>
  );
}

// ── Form primitives (mirrors /contact-sales) ───────────────────────────

const inputStyle: React.CSSProperties = {
  width:        '100%',
  border:       '1px solid #dadce0',
  borderRadius: 10,
  padding:      '11px 14px',
  fontSize:     15,
  background:   '#fff',
  color:        '#202124',
  outline:      'none',
  transition:   'border-color .15s, box-shadow .15s',
  fontFamily:   'inherit',
  resize:       'vertical',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#3c4043' }}>{label}</span>
      {children}
    </label>
  );
}
