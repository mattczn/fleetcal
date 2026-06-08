/**
 * Global 404. Replaces Next.js's default "404 | This page could not be
 * found." with a branded page that gives the user somewhere useful to go.
 *
 * Triggers:
 *   - typed-in nonsense URL
 *   - dead link from an external referrer
 *   - notFound() called explicitly from a server component
 *   - bookmark that survived a route restructure
 *
 * No "report this" CTA because there's nothing to report — 404s are
 * expected. If a deep link from inside the app 404s repeatedly, our
 * routing has a bug and Sentry will catch the upstream cause.
 */
import Link from 'next/link';

export default function NotFound() {
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
          color:         'var(--gc-blue)',
          marginBottom:  16,
        }}
      >
        404 · Not Found
      </div>
      <h1
        className="font-display"
        style={{
          fontSize:      'clamp(36px, 6vw, 64px)',
          fontWeight:    800,
          letterSpacing: '-0.022em',
          lineHeight:    1.05,
          marginBottom:  18,
          maxWidth:      720,
        }}
      >
        That page took a wrong turn.
      </h1>
      <p
        style={{
          fontSize:     17,
          lineHeight:   1.55,
          color:        'var(--gc-text-2)',
          marginBottom: 36,
          maxWidth:     480,
        }}
      >
        The URL you followed doesn&apos;t exist on FleetCal. Could be a
        bad link, an old bookmark, or a typo. No data was lost.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-4">
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
            background:     'var(--gc-blue)',
            color:          '#fff',
          }}
        >
          Back to FleetCal
        </Link>
        <Link
          href="/calendar"
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
          Open calendar →
        </Link>
      </div>
    </div>
  );
}
