'use client';

/**
 * Root-level error boundary. Triggers ONLY when app/layout.tsx itself
 * throws — e.g. ClerkProvider crashes, font loader throws, env var
 * access fails. In that case the entire <html>/<body> tree is missing,
 * so this file must render those tags itself.
 *
 * Stripped of every theme variable / font / Clerk provider for the same
 * reason — if the root layout died, those probably don't exist either.
 * Plain inline styles only.
 *
 * Sentry reporting happens in useEffect (client-side) since this only
 * mounts in the browser.
 */
import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { digest: error.digest ?? 'no-digest' },
      contexts: { 'next.js': { boundary: 'app/global-error.tsx' } },
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin:     0,
          minHeight:  '100vh',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#ffffff',
          color:      '#202124',
          display:    'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding:    24,
          textAlign:  'center',
        }}
      >
        <div style={{ maxWidth: 540 }}>
          <div
            style={{
              fontSize:      13,
              fontWeight:    700,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color:         '#d93025',
              marginBottom:  16,
            }}
          >
            FleetCal is having a moment
          </div>
          <h1
            style={{
              fontSize:      40,
              fontWeight:    800,
              lineHeight:    1.1,
              letterSpacing: '-0.02em',
              margin:        '0 0 20px',
            }}
          >
            We&apos;ll be right back.
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.55, color: '#5f6368', margin: '0 0 32px' }}>
            The whole app failed to load. This usually means a deploy is
            mid-rollout. Reload in 30 seconds — it should be back.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding:        '12px 28px',
              borderRadius:   999,
              fontSize:       15,
              fontWeight:     600,
              background:     '#1a73e8',
              color:          '#fff',
              border:         'none',
              cursor:         'pointer',
            }}
          >
            Reload
          </button>
          {error.digest && (
            <div style={{ marginTop: 24, fontSize: 12, color: '#9aa0a6', fontFamily: 'ui-monospace, monospace' }}>
              Error ID: {error.digest}
            </div>
          )}
        </div>
      </body>
    </html>
  );
}
