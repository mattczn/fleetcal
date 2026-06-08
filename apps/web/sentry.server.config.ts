/**
 * Sentry — Next.js Node.js server init.
 *
 * Captures errors thrown by Server Components, route handlers (the
 * /app/api/* set), and middleware that runs in the Node runtime.
 *
 * DSN comes from SENTRY_DSN (server-only env var, NOT NEXT_PUBLIC_).
 * If missing, init is a no-op.
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
