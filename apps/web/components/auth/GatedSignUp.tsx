'use client';

/**
 * GatedSignUp — wraps Clerk's <SignUp /> with an explicit Terms +
 * Privacy + SMS consent checkbox that must be ticked before the
 * sign-up form becomes interactive.
 *
 * Why a gate rather than the disclaimer-text-under-form pattern:
 *   - Carrier 10DLC reviewers (and TCPA defense) like to see an
 *     unchecked-by-default checkbox at the point of opt-in, not
 *     just a paragraph the user can ignore.
 *   - The checkbox label IS the consent statement, so the act of
 *     ticking is the affirmative agreement.
 *
 * Implementation: until `accepted` is true, the SignUp container
 * gets `pointer-events: none` + faded opacity, and we also block
 * keyboard focus by setting `inert` on it. The Clerk component
 * itself is untouched (no DOM surgery, so future Clerk upgrades
 * don't break this). We don't try to persist consent server-side
 * here — that comes later via a Clerk webhook that stamps a
 * `terms_accepted_at` on the new user's public metadata; for now,
 * the visible-tick-at-time-of-submit is the legally meaningful
 * action.
 */

import { useState, type ComponentProps } from 'react';
import Link from 'next/link';
import { SignUp } from '@clerk/nextjs';

export default function GatedSignUp(props: ComponentProps<typeof SignUp>) {
  const [accepted, setAccepted] = useState(false);

  return (
    <div>
      {/* Consent checkbox — unchecked by default, explicitly affirmative. */}
      <label
        htmlFor="fc-terms-accept"
        style={{
          display:      'flex',
          alignItems:   'flex-start',
          gap:          12,
          padding:      '14px 16px',
          marginBottom: 16,
          borderRadius: 10,
          border:       `1px solid ${accepted ? '#a8c7fa' : '#e0e0e0'}`,
          background:   accepted ? '#e8f0fe' : '#ffffff',
          cursor:       'pointer',
          transition:   'background 200ms, border-color 200ms',
          maxWidth:     420,
          marginLeft:   'auto',
          marginRight:  'auto',
        }}>
        <input
          id="fc-terms-accept"
          type="checkbox"
          checked={accepted}
          onChange={e => setAccepted(e.target.checked)}
          style={{
            marginTop: 3,
            width:     16,
            height:    16,
            cursor:    'pointer',
            flexShrink: 0,
          }} />
        <span style={{
          fontSize:   13,
          lineHeight: 1.55,
          color:      '#3c4043',
        }}>
          I agree to FleetCal&rsquo;s{' '}
          <Link
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ color: '#1558d6', textDecoration: 'underline' }}>
            Terms of Service
          </Link>{' '}and{' '}
          <Link
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{ color: '#1558d6', textDecoration: 'underline' }}>
            Privacy Policy
          </Link>, including consent to receive transactional SMS related to my account and dispatch operations
          (load assignments, schedule changes, verification codes). Message and data rates may apply. Frequency
          varies. Reply STOP to opt out, HELP for help.
        </span>
      </label>

      {/* Gated SignUp — visually + interactively disabled until accepted.
          React 19's typings accept `inert` as a boolean and forward it
          natively to the DOM (the HTML attribute is boolean-typed). The
          pointer-events / opacity styles are a fallback for environments
          where `inert` isn't yet polyfilled. */}
      <div
        inert={!accepted}
        aria-disabled={!accepted}
        style={{
          pointerEvents: accepted ? 'auto' : 'none',
          opacity:       accepted ? 1 : 0.45,
          transition:    'opacity 200ms',
          filter:        accepted ? 'none' : 'grayscale(0.4)',
        }}>
        <SignUp {...props} />
      </div>

      {!accepted && (
        <p style={{
          fontSize:   12,
          color:      '#5f6368',
          textAlign:  'center',
          marginTop:  12,
          fontStyle:  'italic',
        }}>
          Check the box above to continue.
        </p>
      )}
    </div>
  );
}
