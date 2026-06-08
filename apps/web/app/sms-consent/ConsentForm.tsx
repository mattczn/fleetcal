'use client';

/**
 * Client form rendered on the public /sms-consent page. Mirrors
 * Twilio's example screenshot exactly — every element they list
 * as required is present:
 *
 *   1. Phone number input
 *   2. Checkbox for consent (unchecked by default)
 *   3. Description of message types
 *   4. Message frequency
 *   5. Standard rate disclaimer
 *   6. HELP/STOP instructions
 *   7. Terms of Service + Privacy Policy links
 *   8. Submit button with affirmative copy
 *
 * Submission posts to /api/sms/opt-in. The full consent statement
 * text is sent along too so the API stores a verbatim copy of what
 * the user agreed to — that copy is what protects you in a TCPA
 * audit later, even after the UI text changes.
 */

import { useState } from 'react';
import Link from 'next/link';

// EXACT consent language sent to the API and stored verbatim.
// Edits here propagate to new rows; old rows retain their original
// copy so the audit trail is honest about what each user saw.
const CONSENT_STATEMENT =
  'Yes, I would like to receive automated text messages from FleetCal about ' +
  'dispatch operations including load assignments, schedule changes, pickup ' +
  'and delivery reminders, and account verification codes. I understand I ' +
  'will receive up to 10 messages per day during active dispatch and that ' +
  'message and data rates may apply.';

interface SubmitState {
  status:  'idle' | 'submitting' | 'success' | 'error';
  error?:  string;
  phone?:  string;   // E.164 echoed back from the server on success
}

export default function ConsentForm() {
  const [phone,    setPhone]    = useState('');
  const [agreed,   setAgreed]   = useState(false);
  const [state,    setState]    = useState<SubmitState>({ status: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed) {
      setState({ status: 'error', error: 'Please check the consent box to continue.' });
      return;
    }
    if (!phone.trim()) {
      setState({ status: 'error', error: 'Please enter your mobile phone number.' });
      return;
    }
    setState({ status: 'submitting' });
    try {
      const res = await fetch('/api/sms/opt-in', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ phone, consent_text: CONSENT_STATEMENT }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = body?.error ?? 'Something went wrong. Please try again.';
        const human = err === 'invalid_phone'
          ? 'That phone number doesn’t look right. Use the format (555) 123-4567 or +15551234567.'
          : err === 'rate_limited'
            ? 'Too many submissions from this network. Please wait a minute and try again.'
            : 'We couldn’t record your consent. Please try again or email hello@fleetcal.app.';
        setState({ status: 'error', error: human });
        return;
      }
      setState({ status: 'success', phone: body.phone });
    } catch {
      setState({ status: 'error', error: 'Network error. Please try again.' });
    }
  }

  if (state.status === 'success') {
    return (
      <div style={CARD_STYLE}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#137333', marginBottom: 12 }}>
          You&rsquo;re subscribed
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#3c4043' }}>
          We&rsquo;ve recorded your consent for <strong>{state.phone}</strong>. You&rsquo;ll receive
          transactional SMS from FleetCal related to dispatch operations. Reply <strong>STOP</strong> at any
          time to opt out, or <strong>HELP</strong> for help.
        </p>
        <p style={{ fontSize: 12, color: '#5f6368', marginTop: 16 }}>
          Need help right now? Email{' '}
          <a href="mailto:hello@fleetcal.app" style={{ color: '#1558d6' }}>hello@fleetcal.app</a>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={CARD_STYLE} noValidate>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: '#202124', margin: 0, marginBottom: 4, textAlign: 'center' }}>
        FleetCal Driver SMS Subscription
      </h2>
      <p style={{ fontSize: 13, color: '#5f6368', textAlign: 'center', marginTop: 0, marginBottom: 18 }}>
        Sign up to receive dispatch text messages from FleetCal.
      </p>

      {/* 1. Phone number input */}
      <label htmlFor="sms-phone" style={LABEL_STYLE}>
        Mobile Phone Number<span style={{ color: '#c5221f' }}> *</span>
      </label>
      <input
        id="sms-phone"
        type="tel"
        autoComplete="tel"
        required
        placeholder="(555) 123-4567"
        value={phone}
        onChange={e => setPhone(e.target.value)}
        style={INPUT_STYLE} />

      {/* 2 + 3. Checkbox + description of message types */}
      <label htmlFor="sms-agree" style={{
        display:      'flex',
        alignItems:   'flex-start',
        gap:          10,
        marginTop:    16,
        padding:      '10px 12px',
        borderRadius: 8,
        border:       `1px solid ${agreed ? '#a8c7fa' : '#e0e0e0'}`,
        background:   agreed ? '#e8f0fe' : '#ffffff',
        cursor:       'pointer',
        transition:   'background 200ms, border-color 200ms',
      }}>
        <input
          id="sms-agree"
          type="checkbox"
          checked={agreed}
          onChange={e => setAgreed(e.target.checked)}
          style={{ marginTop: 3, width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, lineHeight: 1.55, color: '#3c4043' }}>
          {CONSENT_STATEMENT}
        </span>
      </label>

      {/* 4. Frequency */}
      <div style={DISCLOSURE_BLOCK}>
        <strong>Message Frequency:</strong> You will receive up to 10 messages per day during active dispatch.
      </div>

      {/* 5. Standard rate disclaimer */}
      <div style={DISCLOSURE_BLOCK}>
        <strong>Standard Rates:</strong> Message and data rates may apply depending on your mobile phone
        service plan.
      </div>

      {/* 6. HELP / STOP instructions */}
      <div style={DISCLOSURE_BLOCK}>
        <strong>Help &amp; Stop:</strong> Reply <strong>HELP</strong> for help or <strong>STOP</strong> to
        cancel at any time. By providing your phone number and checking the box above, you agree to receive
        text messages from FleetCal. Consent is not a condition of purchase.
      </div>

      {/* 7. Terms + Privacy links */}
      <div style={{ marginTop: 12, fontSize: 12.5, textAlign: 'center' }}>
        <Link href="/terms"   style={LINK_STYLE} target="_blank" rel="noopener noreferrer">Terms of Service</Link>
        <span style={{ color: '#9aa0a6', margin: '0 8px' }}>|</span>
        <Link href="/privacy" style={LINK_STYLE} target="_blank" rel="noopener noreferrer">Privacy Policy</Link>
      </div>

      {state.status === 'error' && state.error && (
        <div style={{
          marginTop:  14,
          padding:    '10px 12px',
          background: '#fce8e6',
          color:      '#c5221f',
          fontSize:   13,
          borderRadius: 8,
        }}>
          {state.error}
        </div>
      )}

      {/* 8. Submit button */}
      <button
        type="submit"
        disabled={state.status === 'submitting'}
        style={{
          marginTop:  16,
          width:      '100%',
          padding:    '12px 16px',
          background: '#202124',
          color:      '#ffffff',
          border:     'none',
          borderRadius: 999,
          fontSize:   14.5,
          fontWeight: 700,
          cursor:     state.status === 'submitting' ? 'wait' : 'pointer',
          opacity:    state.status === 'submitting' ? 0.7 : 1,
        }}>
        {state.status === 'submitting' ? 'Submitting…' : 'Yes, sign me up!'}
      </button>
    </form>
  );
}

// ── Styles (inline to keep the page self-contained) ──────────────

const CARD_STYLE: React.CSSProperties = {
  background:   '#ffffff',
  border:       '1px solid #e8eaed',
  borderRadius: 12,
  padding:      '28px 24px',
  maxWidth:     420,
  width:        '100%',
  boxShadow:    '0 1px 3px rgba(60,64,67,0.08), 0 2px 12px rgba(60,64,67,0.04)',
};

const LABEL_STYLE: React.CSSProperties = {
  display:    'block',
  fontSize:   13,
  fontWeight: 600,
  color:      '#3c4043',
  marginBottom: 6,
};

const INPUT_STYLE: React.CSSProperties = {
  width:        '100%',
  padding:      '11px 14px',
  fontSize:     14.5,
  border:       '1px solid #dadce0',
  borderRadius: 8,
  background:   '#f8f9fa',
  outline:      'none',
};

const DISCLOSURE_BLOCK: React.CSSProperties = {
  marginTop:  10,
  fontSize:   12.5,
  lineHeight: 1.55,
  color:      '#3c4043',
};

const LINK_STYLE: React.CSSProperties = {
  color:          '#1558d6',
  textDecoration: 'underline',
};
