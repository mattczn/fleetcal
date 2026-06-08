/**
 * Sentry — browser-side init.
 *
 * Runs on every page load. Captures uncaught client exceptions, route
 * navigation errors, and explicit Sentry.captureException calls from
 * components (e.g. our error.tsx / errorToast helper).
 *
 * DSN comes from NEXT_PUBLIC_SENTRY_DSN — set in Vercel env. If the
 * env is missing (local dev, preview without secrets), Sentry init is
 * a no-op — no crash, just no telemetry.
 *
 * tracesSampleRate is set low (10%) because traces are billed per
 * event and we don't need to capture every page navigation. Errors
 * are always captured (sampleRate stays at default 1.0).
 *
 * replaysSessionSampleRate is 0 (off) — Session Replay records the
 * user's interactions and DOM, which is gold for debugging but also
 * blows through the free tier quickly. Flip on later if we hit a
 * "can't reproduce" bug class.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    // Don't capture errors thrown by browser extensions or the like.
    ignoreErrors: [
      // Common browser-extension noise
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      // Network blips (already toasted by errorToast helper)
      'Network request failed',
      'Failed to fetch',
      'Load failed',
    ],
  });
}
