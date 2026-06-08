/**
 * Sentry — Edge runtime init.
 *
 * Captures errors thrown by middleware.ts (which runs in Vercel's
 * Edge runtime). Crucial — our middleware crash last week is exactly
 * the class of bug this catches.
 *
 * DSN comes from SENTRY_DSN. If missing, init is a no-op.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? 'development',
    tracesSampleRate: 0.1,
  });
}
