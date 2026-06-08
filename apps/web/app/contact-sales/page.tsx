/**
 * /contact-sales — 5-step lead-qualification wizard.
 *
 * Renders a single question at a time. Steps 1-4 are multiple-choice and
 * auto-advance the moment the user picks an option. Step 5 is the contact
 * form (name, email, phone, company, free text). Final submit POSTs to
 * the API's /v1/contact-sales endpoint which emails CONTACT_SALES_TO
 * (defaults to hello@fleetcal.app) via Resend.
 *
 * Routed from the marketing footer's "Contact sales" link (was a mailto
 * that dropped people into their mail app with an empty draft — now a
 * structured intake so sales reads pre-qualified leads).
 *
 * Anti-spam: hidden honeypot input + loaded-at timestamp shipped with
 * the body. Both are enforced server-side, so a direct cURL can't bypass.
 */
'use client';

import { useState, useRef, useMemo } from 'react';
import Link from 'next/link';
import MarketingNav from '@/components/marketing/MarketingNav';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';

interface ChoiceQuestion {
  kind:    'choice';
  key:     'fleetSize' | 'currentTool' | 'freightType' | 'topPain';
  prompt:  string;
  sub:     string;
  /** When true the user can tick multiple boxes and has to click Next
   *  to advance. Single-select questions auto-advance on the tap. */
  multi?:  boolean;
  options: ReadonlyArray<{ value: string; label: string; hint?: string }>;
}

const QUESTIONS: ReadonlyArray<ChoiceQuestion> = [
  {
    kind:   'choice',
    key:    'fleetSize',
    prompt: 'How many trucks do you run?',
    sub:    'We match you to the right plan, no matter the size.',
    options: [
      { value: '1-4',   label: '1 to 4',    hint: 'Owner-op territory' },
      { value: '5-9',   label: '5 to 9',    hint: 'Hired your first dispatcher' },
      { value: '10-14', label: '10 to 14',  hint: 'Dispatch is its own desk' },
      { value: '15+',   label: '15 or more', hint: "We'll size a plan for you" },
    ],
  },
  {
    kind:   'choice',
    key:    'currentTool',
    prompt: 'What are you using to dispatch today?',
    sub:    "Helps us understand the migration you're planning.",
    options: [
      { value: 'spreadsheets', label: 'Spreadsheets' },
      { value: 'whiteboard',   label: 'Whiteboard or paper' },
      { value: 'alvys',        label: 'Alvys' },
      { value: 'roserocket',   label: 'RoseRocket' },
      { value: 'mcleod',       label: 'McLeod' },
      { value: 'other_tms',    label: 'Another TMS' },
      { value: 'none',         label: 'Nothing yet' },
    ],
  },
  {
    kind:   'choice',
    key:    'freightType',
    prompt: "What's your primary freight?",
    sub:    'Pick the closest. Mixed fleets are common, we plan for that.',
    options: [
      { value: 'otr',       label: 'OTR' },
      { value: 'local',     label: 'Local' },
      { value: 'regional',  label: 'Regional' },
      { value: 'dedicated', label: 'Dedicated' },
      { value: 'mixed',     label: 'Mixed' },
    ],
  },
  {
    kind:   'choice',
    key:    'topPain',
    prompt: 'Where does it hurt right now?',
    sub:    'Pick everything that costs you hours each week. We hear most fleets tick more than one.',
    multi:  true,
    options: [
      { value: 'dispatch',   label: 'Dispatch chaos' },
      { value: 'invoicing',  label: 'Slow invoicing' },
      { value: 'pod',        label: 'Missing PODs' },
      { value: 'payroll',    label: 'Driver payroll' },
      { value: 'billing',    label: 'Customer billing accuracy' },
      { value: 'other',      label: 'Something else' },
    ],
  },
];

const API_BASE = process.env.NEXT_PUBLIC_RAILWAY_URL ?? 'https://fleetcalapi-production.up.railway.app';

const CTA = { href: '/sign-up', label: 'Start free trial' };

interface ContactForm {
  fleetSize:   string;
  currentTool: string;
  freightType: string;
  topPain:     string;
  name:        string;
  email:       string;
  phone:       string;
  company:     string;
  message:     string;
}

const EMPTY_FORM: ContactForm = {
  fleetSize: '', currentTool: '', freightType: '', topPain: '',
  name: '', email: '', phone: '', company: '', message: '',
};

export default function ContactSalesPage() {
  const [step, setStep]   = useState(0);        // 0..4
  const [form, setForm]   = useState<ContactForm>(EMPTY_FORM);
  const [busy, setBusy]   = useState(false);
  const [sent, setSent]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const honeypotRef       = useRef<HTMLInputElement>(null);
  // Captures the moment the wizard mounted. The server rejects payloads
  // that come back in < 2s — humans can't fill the form that fast.
  const [loadedAt] = useState(() => Date.now());

  const TOTAL = QUESTIONS.length + 1; // +1 for contact form
  const isChoiceStep  = step < QUESTIONS.length;
  const isContactStep = step === QUESTIONS.length;
  const currentQ      = isChoiceStep ? QUESTIONS[step] : null;

  // For the choice steps, what's currently selected. Single-select
  // questions store one value; multi-select stores a comma-separated
  // string ("dispatch,invoicing") that we split for the active check.
  const selectedForStep = currentQ ? form[currentQ.key] : '';
  const selectedValues  = selectedForStep ? selectedForStep.split(',') : [];
  function isSelected(value: string): boolean {
    if (!currentQ) return false;
    return currentQ.multi
      ? selectedValues.includes(value)
      : selectedForStep === value;
  }

  // Computed recommended plan label so we can echo it back on the
  // contact-info step ("Looks like Growth fits — we'll lead with that").
  const recommendation = useMemo(() => {
    switch (form.fleetSize) {
      case '1-4':   return { name: 'Owner Op', price: '$99/mo'  };
      case '5-9':   return { name: 'Growth',   price: '$149/mo' };
      case '10-14': return { name: 'Fleet',    price: '$199/mo' };
      case '15+':   return { name: 'Custom plan', price: 'sales-sized' };
      default:      return null;
    }
  }, [form.fleetSize]);

  function pickChoice(value: string) {
    if (!currentQ) return;
    if (currentQ.multi) {
      // Toggle in/out of the comma-separated list. Don't auto-advance;
      // the user might want to tick more than one box. They click the
      // Continue button at the bottom when they're done.
      setForm(prev => {
        const prevList = prev[currentQ.key] ? prev[currentQ.key].split(',') : [];
        const nextList = prevList.includes(value)
          ? prevList.filter(v => v !== value)
          : [...prevList, value];
        return { ...prev, [currentQ.key]: nextList.join(',') };
      });
      return;
    }
    setForm(prev => ({ ...prev, [currentQ.key]: value }));
    // Single-select: auto-advance after a tiny delay so the user sees
    // the selected ring light up before the step transition.
    setTimeout(() => setStep(s => Math.min(s + 1, QUESTIONS.length)), 180);
  }

  function next() {
    setStep(s => Math.min(s + 1, QUESTIONS.length));
  }

  function back() {
    setStep(s => Math.max(0, s - 1));
  }

  function updateField<K extends keyof ContactForm>(key: K, value: ContactForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    // Client-side guards mirror the server's. We never block the
    // server's word though — it's the source of truth.
    if (!form.name.trim()) { setError('Please add your name.'); return; }
    if (!form.email.includes('@')) { setError('Please use a real email.'); return; }

    setBusy(true);
    try {
      // Convert internal values → human labels for the email. The form
      // state stores codes ("1-4", "spreadsheets") for the
      // recommendation switch + multi-select dedupe, but the inbox
      // wants something readable ("1 to 4", "Spreadsheets"). For multi-
      // select, split the comma-separated list and join the labels with
      // a comma + space.
      const labeled = QUESTIONS.reduce<Record<string, string>>((acc, q) => {
        const raw = form[q.key];
        if (!raw) return acc;
        if (q.multi) {
          const labels = raw.split(',').map(v =>
            q.options.find(o => o.value === v)?.label ?? v,
          );
          acc[q.key] = labels.join(', ');
        } else {
          acc[q.key] = q.options.find(o => o.value === raw)?.label ?? raw;
        }
        return acc;
      }, {});

      const res = await fetch(`${API_BASE}/v1/contact-sales`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          ...labeled,
          website:  honeypotRef.current?.value ?? '',
          loadedAt,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.errors?.[0] ?? body?.error ?? 'Something went wrong sending the form.');
        setBusy(false);
        return;
      }
      setSent(true);
    } catch {
      setError("Couldn't reach the FleetCal server. Try again or email hello@fleetcal.app directly.");
      setBusy(false);
    }
  }

  return (
    <div
      data-marketing-scroll
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{ scrollBehavior: 'smooth' }}
    >
      <MarketingNav cta={CTA} showSignIn />

      <section
        className="flex flex-col"
        style={{
          background:    'radial-gradient(ellipse 70% 90% at 88% 0%, #e8f0fe 0%, #fff 60%)',
          minHeight:     'calc(100vh - 68px)',
          paddingTop:    56,
          paddingBottom: 56,
        }}
      >
        <div className="mx-auto w-full max-w-[760px] px-5 sm:px-6 md:px-8">

          {/* Pre-wizard intro (only on step 0) */}
          {step === 0 && !sent && (
            <div className="text-center mb-10">
              <span className="font-mono" style={{
                fontSize: 12, fontWeight: 600, letterSpacing: '0.14em',
                textTransform: 'uppercase', color: '#1967d2',
              }}>
                Talk to sales
              </span>
              <h1 className="font-display" style={{
                fontWeight: 800, fontSize: 'clamp(30px, 4vw, 44px)',
                lineHeight: 1.08, margin: '12px 0 0', letterSpacing: '-0.022em',
              }}>
                A few quick questions<br className="hidden lg:inline" />{' '}
                <span style={{ color: 'var(--gc-blue)' }}>before we hop on a call.</span>
              </h1>
              <p style={{ fontSize: 16.5, lineHeight: 1.6, color: '#5f6368', margin: '14px auto 0', maxWidth: 540 }}>
                Takes under a minute. We&apos;ll use your answers to send you to the
                right person on our team.
              </p>
            </div>
          )}

          {/* Progress + back row (hidden on the success screen) */}
          {!sent && (
            <div className="flex items-center justify-between mb-6">
              <button
                type="button"
                onClick={back}
                disabled={step === 0}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium"
                style={{
                  color:   step === 0 ? '#bdc1c6' : '#5f6368',
                  cursor:  step === 0 ? 'default' : 'pointer',
                }}
              >
                <ArrowLeft size={14} /> Back
              </button>
              <ProgressDots step={step} total={TOTAL} />
              <span className="font-mono" style={{ fontSize: 12, color: '#5f6368' }}>
                Step {step + 1} of {TOTAL}
              </span>
            </div>
          )}

          {/* Card */}
          <div
            style={{
              background:   '#fff',
              border:       '1px solid #e8eaed',
              borderRadius: 24,
              boxShadow:    'var(--shadow-soft)',
              padding:      '36px 28px',
            }}
          >
            {sent ? (
              <SuccessPanel />
            ) : isChoiceStep && currentQ ? (
              <div>
                <h2 className="font-display" style={{
                  fontWeight: 800, fontSize: 'clamp(22px, 2.6vw, 28px)',
                  lineHeight: 1.15, letterSpacing: '-0.012em', color: '#202124',
                  margin: 0,
                }}>
                  {currentQ.prompt}
                </h2>
                <p style={{ fontSize: 15, color: '#5f6368', margin: '8px 0 22px' }}>
                  {currentQ.sub}
                </p>
                <div className="grid gap-3" style={{ gridTemplateColumns: '1fr' }}>
                  {currentQ.options.map(opt => {
                    const active = isSelected(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => pickChoice(opt.value)}
                        className="text-left"
                        style={{
                          display: 'flex', alignItems: 'center',
                          justifyContent: 'space-between',
                          background:   active ? '#e8f0fe' : '#fff',
                          border:       active ? '2px solid var(--gc-blue)' : '1px solid #dadce0',
                          borderRadius: 14,
                          padding:      active ? '13px 17px' : '14px 18px',
                          cursor:       'pointer',
                          transition:   'background .15s, border-color .15s',
                          fontSize:     16,
                          fontWeight:   600,
                          color:        active ? '#1967d2' : '#202124',
                        }}
                      >
                        <span className="flex items-center gap-3">
                          {/* Square indicator on multi-select questions
                              (looks like a real checkbox) and a circle on
                              single-select (radio affordance). Same
                              filled-blue treatment when active. */}
                          <span style={{
                            width:        20, height: 20,
                            borderRadius: currentQ.multi ? 5 : 999,
                            border:       active ? 'none' : '2px solid #dadce0',
                            background:   active ? 'var(--gc-blue)' : 'transparent',
                            display:      'inline-flex',
                            alignItems:   'center',
                            justifyContent: 'center',
                            flex:         'none',
                          }}>
                            {active && <Check size={12} strokeWidth={3} style={{ color: '#fff' }} />}
                          </span>
                          <span>{opt.label}</span>
                        </span>
                        {opt.hint && (
                          <span style={{ fontSize: 13, fontWeight: 500, color: active ? '#1967d2' : '#5f6368' }}>
                            {opt.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* Multi-select needs an explicit Continue — auto-advance
                    would skip out before the user finishes ticking
                    boxes. Disabled until they pick at least one. */}
                {currentQ.multi && (
                  <div className="flex justify-end mt-6">
                    <button
                      type="button"
                      onClick={next}
                      disabled={selectedValues.length === 0}
                      className="font-display inline-flex items-center justify-center"
                      style={{
                        background:    'var(--gc-blue)',
                        color:         '#fff',
                        fontWeight:    600,
                        fontSize:      15,
                        padding:       '12px 22px',
                        borderRadius:  999,
                        border:        'none',
                        cursor:        selectedValues.length === 0 ? 'default' : 'pointer',
                        opacity:       selectedValues.length === 0 ? 0.5 : 1,
                        transition:    'opacity .15s',
                        gap:           8,
                      }}
                    >
                      Continue <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </div>
            ) : isContactStep ? (
              <ContactStep
                form={form}
                update={updateField}
                onSubmit={submit}
                busy={busy}
                error={error}
                honeypotRef={honeypotRef}
                recommendation={recommendation}
              />
            ) : null}
          </div>

          {/* Bail-out line */}
          {!sent && (
            <p className="text-center" style={{ fontSize: 13, color: '#5f6368', marginTop: 22 }}>
              Prefer email?{' '}
              <Link href="mailto:hello@fleetcal.app" style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none' }}>
                hello@fleetcal.app
              </Link>
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function ProgressDots({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            width:        i === step ? 22 : 7,
            height:       7,
            borderRadius: 999,
            background:   i <= step ? 'var(--gc-blue)' : '#e8eaed',
            transition:   'width .2s, background .2s',
          }}
        />
      ))}
    </div>
  );
}

interface ContactStepProps {
  form:            ContactForm;
  update:          <K extends keyof ContactForm>(key: K, value: ContactForm[K]) => void;
  onSubmit:        (e: React.FormEvent) => void;
  busy:            boolean;
  error:           string | null;
  honeypotRef:     React.RefObject<HTMLInputElement | null>;
  recommendation:  { name: string; price: string } | null;
}

function ContactStep({ form, update, onSubmit, busy, error, honeypotRef, recommendation }: ContactStepProps) {
  return (
    <div>
      <h2 className="font-display" style={{
        fontWeight: 800, fontSize: 'clamp(22px, 2.6vw, 28px)',
        lineHeight: 1.15, letterSpacing: '-0.012em', color: '#202124',
        margin: 0,
      }}>
        Tell us how to reach you.
      </h2>
      <p style={{ fontSize: 15, color: '#5f6368', margin: '8px 0 18px' }}>
        We&apos;ll respond within one business day. Often much faster.
      </p>

      {recommendation && (
        <div style={{
          background:   '#e8f0fe',
          border:       '1px solid #d2e3fc',
          borderRadius: 12,
          padding:      '12px 14px',
          marginBottom: 22,
          display:      'flex',
          alignItems:   'center',
          gap:          10,
        }}>
          <span style={{
            width: 28, height: 28, borderRadius: 999, background: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid #d2e3fc', flex: 'none',
          }}>
            <Check size={14} strokeWidth={3} style={{ color: '#1a73e8' }} />
          </span>
          <div style={{ fontSize: 14, color: '#1967d2' }}>
            Based on your fleet, the{' '}
            <strong style={{ fontWeight: 700 }}>{recommendation.name}</strong> plan ({recommendation.price})
            looks like the fit. We&apos;ll lead with that.
          </div>
        </div>
      )}

      <form onSubmit={onSubmit} className="grid gap-4">
        {/* Honeypot — visually hidden, real users never fill it */}
        <div className="absolute -left-[9999px] overflow-hidden" aria-hidden="true">
          <input ref={honeypotRef} type="text" name="website" tabIndex={-1} autoComplete="off" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Your name *">
            <Input value={form.name} onChange={v => update('name', v)} placeholder="Jane Dispatcher" />
          </Field>
          <Field label="Email *">
            <Input type="email" value={form.email} onChange={v => update('email', v)} placeholder="you@yourfleet.com" />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Phone (optional)">
            <Input type="tel" value={form.phone} onChange={v => update('phone', v)} placeholder="(555) 555-5555" />
          </Field>
          <Field label="Company">
            <Input value={form.company} onChange={v => update('company', v)} placeholder="Your fleet name" />
          </Field>
        </div>
        <Field label="Anything else you'd like to share?">
          <textarea
            rows={4}
            value={form.message}
            onChange={e => update('message', e.target.value)}
            placeholder="Specific workflow questions, integrations you need, current pain points…"
            style={inputStyle}
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
            background:    'var(--gc-blue)',
            color:         '#fff',
            fontWeight:    600,
            fontSize:      16,
            padding:       '14px 24px',
            borderRadius:  999,
            border:        'none',
            cursor:        busy ? 'default' : 'pointer',
            opacity:       busy ? 0.7 : 1,
            transition:    'opacity .15s, background .15s',
            gap:           8,
            marginTop:     2,
          }}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          {busy ? 'Sending…' : 'Send to sales'}
        </button>
      </form>
    </div>
  );
}

function SuccessPanel() {
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
        lineHeight: 1.2, letterSpacing: '-0.012em', color: '#202124',
        margin: 0,
      }}>
        Got it. We&apos;ll be in touch.
      </h2>
      <p style={{ fontSize: 15, color: '#5f6368', margin: '10px auto 0', maxWidth: 420 }}>
        Most contacts hear back from us within a business day. Often much faster.
        In the meantime, feel free to start a free trial.
      </p>
      <Link
        href="/sign-up"
        className="font-display inline-flex items-center justify-center"
        style={{
          background: 'var(--gc-blue)', color: '#fff', fontWeight: 600,
          fontSize: 15, padding: '12px 22px', borderRadius: 999,
          textDecoration: 'none', marginTop: 20, gap: 8,
        }}
      >
        Start free trial <ArrowRight size={15} />
      </Link>
    </div>
  );
}

// ── Form primitives ────────────────────────────────────────────────────

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

function Input({ value, onChange, ...props }: {
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      {...props}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={inputStyle}
    />
  );
}
