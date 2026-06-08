'use client';

/**
 * Route-segment error boundary. Triggers when ANY page or layout throws
 * during render — bad query result, missing data, render-time exception,
 * etc. Without this file Next.js shows a stark "Application error: a
 * client-side exception has occurred" message and that's it.
 *
 * Behavior:
 *   1. Reports the error to Sentry on mount with the digest as a tag,
 *      so when the user pastes the digest into a support ticket we can
 *      find the exact event in Sentry instantly.
 *   2. Shows a friendly message + reset button (which re-renders the
 *      boundary's children — usually fixes transient issues).
 *   3. Surfaces the digest as a clickable "click to copy" affordance.
 *
 * Route-segment errors RESET their boundary instead of full reloading
 * because reloading would lose any unsaved client state. The reset()
 * call is the right fix 90% of the time. For uncaught errors above
 * this boundary (e.g. in the root layout), Next.js uses
 * app/global-error.tsx instead.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import * as Sentry from '@sentry/nextjs';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Report to Sentry with the digest as a tag so support reports
    // referencing the digest can find the full event in one click.
    Sentry.captureException(error, {
      tags: { digest: error.digest ?? 'no-digest' },
      contexts: { 'next.js': { boundary: 'app/error.tsx' } },
    });
  }, [error]);

  const errorId = error.digest ?? 'unknown';

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center px-6 py-24 text-center"
      style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-1)' }}
    >
      <div
        className="font-display"
        style={{
          fontSize:      14,
          fontWeight:    700,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color:         '#d93025',
          marginBottom:  16,
        }}
      >
        Something went wrong
      </div>
      <h1
        className="font-display"
        style={{
          fontSize:      'clamp(36px, 6vw, 56px)',
          fontWeight:    800,
          letterSpacing: '-0.022em',
          lineHeight:    1.05,
          marginBottom:  18,
          maxWidth:      720,
        }}
      >
        We hit a snag rendering this page.
      </h1>
      <p
        style={{
          fontSize:     17,
          lineHeight:   1.55,
          color:        'var(--gc-text-2)',
          marginBottom: 28,
          maxWidth:     520,
        }}
      >
        Our team has been notified automatically. Try again — most issues
        are transient. If it keeps happening, share the error ID below
        with support.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-4 mb-10">
        <button
          type="button"
          onClick={reset}
          className="font-display"
          style={{
            display:        'inline-flex',
            alignItems:     'center',
            gap:            8,
            padding:        '12px 24px',
            borderRadius:   999,
            fontSize:       15,
            fontWeight:     600,
            background:     'var(--gc-blue)',
            color:          '#fff',
            border:         'none',
            cursor:         'pointer',
          }}
        >
          Try again
        </button>
        <Link
          href="/"
          className="font-display"
          style={{
            display:        'inline-flex',
            alignItems:     'center',
            gap:            8,
            padding:        '12px 24px',
            borderRadius:   999,
            fontSize:       15,
            fontWeight:     600,
            textDecoration: 'none',
            background:     'transparent',
            color:          'var(--gc-blue)',
          }}
        >
          Back home →
        </Link>
      </div>

      {/* Error ID — click to copy. Lower-key so it doesn't dominate
          the page, but discoverable for the rare support escalation. */}
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(errorId).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          });
        }}
        title="Click to copy error ID"
        className="font-mono"
        style={{
          background:    'transparent',
          border:        '1px solid var(--gc-border-light)',
          borderRadius:  8,
          padding:       '8px 14px',
          fontSize:      12,
          color:         'var(--gc-text-3)',
          cursor:        'pointer',
        }}
      >
        {copied ? '✓ Copied' : `Error ID: ${errorId}`}
      </button>
    </div>
  );
}
