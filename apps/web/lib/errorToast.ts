/**
 * Standardised user-facing error surface.
 *
 * Single entry point for "something failed during a user action" — pulls
 * a sensible human message out of whatever shape the error has, reports
 * the unexpected stuff to Sentry, and shows a toast. Use this anywhere
 * a `try { await foo() } catch (e) {}` would silently swallow.
 *
 *   try {
 *     await railway.saveLoad(load);
 *     toast.success('Load saved');
 *   } catch (err) {
 *     errorToast(err, 'Could not save the load');
 *   }
 *
 * Categories handled:
 *
 *   - AbortError                → silent (user navigated away)
 *   - Network failure (fetch)    → "Lost connection — try again."
 *   - HTTP 4xx with `message`    → show the message (server is asking
 *                                  for a user-correctable fix)
 *   - HTTP 401 / session expired → silent; auth flow will redirect
 *   - HTTP 403                   → "You don't have permission to do that"
 *   - HTTP 5xx                   → fallback message + report to Sentry
 *                                  + show error ID
 *   - Anything else              → fallback + Sentry
 *
 * Conventions:
 *
 *   - Always pass a 2nd arg (the fallback message) so unknown errors
 *     still read like a sentence in the user's context. "Could not save
 *     the load" >>> "An error occurred".
 *   - For successful actions, use sonner's `toast.success(...)`
 *     directly. This helper is error-only.
 */
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';

interface ErrorWithStatus {
  status?: number;
  statusCode?: number;
  message?: string;
  error?: string;
  errorId?: string;
  digest?: string;
  name?: string;
}

export function errorToast(err: unknown, fallback: string): void {
  // 1. AbortError — user navigated away or cancelled. Silent.
  if (isAbortError(err)) return;

  // 2. Treat as a structured error.
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorWithStatus;
  const status = e.status ?? e.statusCode;

  // 401 = auth issue — Clerk redirects will handle. Don't spam toast.
  if (status === 401) return;

  // Network failure — TypeError("Failed to fetch") shape. We can't talk
  // to the API at all. Different copy from a server error.
  if (isNetworkError(err)) {
    toast.error('Lost connection', {
      description: 'Check your internet and try again.',
    });
    return;
  }

  // 403 = permission. Server-side enforcement of an action UI shouldn't
  // have allowed. The user should know why.
  if (status === 403) {
    toast.error("You don't have permission to do that", {
      description: e.message ?? 'Ask your admin to grant access.',
    });
    return;
  }

  // 4xx — server is asking for a correctable change. Trust its message
  // if present. (We standardise server errors in apps/api/src/lib/errors
  // to always return `{ error, message }`.)
  if (status && status >= 400 && status < 500) {
    toast.error(fallback, {
      description: e.message ?? e.error ?? 'Please try again.',
    });
    return;
  }

  // 5xx and unknown — something we didn't expect. Report to Sentry and
  // show an error ID the user can quote.
  const sentryId = Sentry.captureException(err, {
    tags: { source: 'errorToast', fallback },
  });
  const userVisibleId = e.errorId ?? sentryId ?? 'unknown';

  toast.error(fallback, {
    description: `Something went wrong. Error ID: ${userVisibleId.slice(0, 12)}`,
    duration:    8000,
  });
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

function isNetworkError(err: unknown): boolean {
  // `fetch` rejects with TypeError on network failure.
  if (err instanceof TypeError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string };
  return e.name === 'NetworkError' || e.name === 'TypeError';
}
