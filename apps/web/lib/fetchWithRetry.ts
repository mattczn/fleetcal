/**
 * fetchWithRetry — retry-with-exponential-backoff wrapper for any
 * promise-returning fetch.
 *
 * Why this exists: Railway services can take 30–60s to come up after
 * a deploy or manual restart. When a user navigates to a page during
 * that window, the in-flight requests reject with a 502/503 or a
 * network error. Without a retry, the page renders with empty state
 * and the user is stuck refreshing the browser hoping the server
 * comes back. With a retry, we ride out the cold-start window
 * transparently.
 *
 * Defaults:
 *   • 5 attempts (≈ 200 + 400 + 800 + 1600 + 3200 ms ≈ 6.2 s of
 *     total backoff before surfacing failure).
 *   • Each attempt's wait is the previous wait × 2, starting at
 *     200 ms.
 *   • AbortSignal aware — if the caller's signal fires, we stop
 *     retrying immediately and reject with AbortError.
 *
 * Usage:
 *   const drivers = await fetchWithRetry(() => railway.listDrivers());
 *   // or with cancellation:
 *   const ctrl = new AbortController();
 *   useEffect(() => {
 *     fetchWithRetry(() => railway.listDrivers(), { signal: ctrl.signal })
 *       .then(setDrivers)
 *       .catch(...);
 *     return () => ctrl.abort();
 *   }, []);
 */

export interface FetchWithRetryOptions {
  /** Max number of attempts before giving up. Default 5. */
  attempts?: number;
  /** Initial backoff in ms. Each attempt doubles. Default 200. */
  initialDelayMs?: number;
  /** Cap on a single backoff wait. Default 3200ms. */
  maxDelayMs?: number;
  /** Cancel any pending retries when this fires. */
  signal?: AbortSignal;
  /** Called after each failure (incl. the final one). Useful for
   *  logging or telemetry. */
  onAttemptFailed?: (err: unknown, attempt: number, willRetry: boolean) => void;
}

/** Whether an error is worth retrying. 4xx (except 408 / 429) are
 *  client errors — the request itself is wrong and won't get fixed
 *  by trying again. Retrying a 403 just means logging 5 forbidden
 *  entries in the api_errors dashboard every time a permission-less
 *  user lands on a page. 5xx, 408, 429, network errors, and unknown
 *  shapes (which we treat as "could be transient") all still retry. */
function shouldRetry(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return true;
  const e = err as { status?: number; statusCode?: number; name?: string };
  // AbortError — caller cancelled. The outer signal check will throw,
  // but defensively don't waste a retry.
  if (e.name === 'AbortError') return false;
  const status = e.status ?? e.statusCode;
  if (status === undefined) return true;        // network error / unknown
  if (status >= 500) return true;                // server error
  if (status === 408 || status === 429) return true; // worth retrying
  if (status >= 400) return false;               // other 4xx — deterministic
  return true;                                   // 2xx/3xx never reach catch
}

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  opts: FetchWithRetryOptions = {},
): Promise<T> {
  const attempts        = opts.attempts        ?? 5;
  const initialDelayMs  = opts.initialDelayMs  ?? 200;
  const maxDelayMs      = opts.maxDelayMs      ?? 3200;
  const signal          = opts.signal;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const willRetry = i < attempts - 1 && shouldRetry(err);
      opts.onAttemptFailed?.(err, i + 1, willRetry);
      if (!willRetry) break;
      // Wait, but interruptibly. If the signal fires during the
      // wait, bail out instead of running the next attempt.
      const delay = Math.min(initialDelayMs * 2 ** i, maxDelayMs);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new DOMException('aborted', 'AbortError'));
          };
          signal.addEventListener('abort', onAbort);
        }
      });
    }
  }
  throw lastErr;
}
