/**
 * Sentry REST API client — server-side only.
 *
 * Fetches aggregate metrics for the /admin pulse card from Sentry's
 * stats / issues / releases endpoints. All calls cache for 5 minutes
 * via Next.js's fetch cache so a dashboard reload doesn't hammer
 * Sentry's API (10 req/sec/token cap on the free tier).
 *
 * Required env vars:
 *
 *   SENTRY_API_TOKEN          — auth token with `event:read` +
 *                                `project:read` + `org:read` scopes
 *                                (DIFFERENT from SENTRY_AUTH_TOKEN
 *                                which is build-time only).
 *   SENTRY_ORG                — org slug (e.g. "systematica-solutions")
 *   SENTRY_PROJECT            — web project slug (we read web errors only;
 *                                API errors would need a second project
 *                                slug + duplicated calls — punted).
 *
 * Graceful degradation: every fetcher catches and returns null on
 * failure. Missing tokens, network blips, Sentry-side outages all
 * result in `null` rather than throwing — the dashboard shows a
 * "data unavailable" state instead of 500-ing.
 */

const SENTRY_BASE = 'https://sentry.io/api/0';
const CACHE_SECONDS = 300; // 5 minutes

interface SentryEnv {
  token:   string;
  org:     string;
  project: string;
}

function getEnv(): SentryEnv | null {
  const token   = process.env.SENTRY_API_TOKEN;
  const org     = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!token || !org || !project) return null;
  return { token, org, project };
}

async function sentryFetch<T>(path: string, query: Record<string, string | number>): Promise<T | null> {
  const env = getEnv();
  if (!env) return null;
  const url = new URL(`${SENTRY_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${env.token}` },
      next:    { revalidate: CACHE_SECONDS, tags: ['sentry-admin-metrics'] },
    });
    if (!res.ok) {
      // 401 = bad token, 403 = missing scope, 429 = rate limited. All
      // should be visible in Sentry dashboard logs, not surfaced to the
      // admin user.
      console.warn(`[sentryApi] ${path} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[sentryApi] ${path} threw:`, err);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export interface SentryErrorStats {
  /** Total error events in the queried window. */
  count:       number;
  /** Count in the equivalent window immediately before (for trend
   *  arrows). Same length, so 24h vs prior-24h. */
  prevCount:   number;
  /** Unique users who hit an error in the queried window. */
  affectedUsers: number;
}

interface SentryStatsV2 {
  groups: Array<{
    totals: { 'sum(quantity)': number };
  }>;
}

/**
 * Errors in the last `hours` hours, plus a comparison count for the
 * same duration immediately before. Used to compute the trend arrow.
 *
 * Returns null when Sentry is unreachable / not configured — the UI
 * should render a "data unavailable" state.
 */
export async function fetchErrorStats(hours = 24): Promise<SentryErrorStats | null> {
  const env = getEnv();
  if (!env) return null;

  // Sentry's stats_v2 wants `category=error` to filter just error
  // events (vs. transactions, sessions, etc). `outcome=accepted`
  // means events that actually persisted (not rate-limited or
  // dropped). We want both "got to Sentry" and "error" — those
  // are the bugs.
  const period      = `${hours}h`;
  const periodSecs  = hours * 3600;

  const currentRaw = await sentryFetch<SentryStatsV2>(
    `/organizations/${env.org}/stats_v2/`,
    {
      field:       'sum(quantity)',
      statsPeriod: period,
      project:     env.project,
      category:    'error',
      outcome:     'accepted',
    },
  );
  // Prior window: from 2× ago to 1× ago. The Sentry API takes
  // `start` + `end` as ISO timestamps OR `statsPeriod` — we use the
  // latter with `statsPeriodStart` to offset.
  const nowSecs   = Math.floor(Date.now() / 1000);
  const prevEnd   = nowSecs - periodSecs;
  const prevStart = prevEnd  - periodSecs;
  const prevRaw   = await sentryFetch<SentryStatsV2>(
    `/organizations/${env.org}/stats_v2/`,
    {
      field:    'sum(quantity)',
      start:    new Date(prevStart * 1000).toISOString(),
      end:      new Date(prevEnd * 1000).toISOString(),
      project:  env.project,
      category: 'error',
      outcome:  'accepted',
    },
  );

  if (!currentRaw) return null;

  const count     = sumGroups(currentRaw);
  const prevCount = prevRaw ? sumGroups(prevRaw) : 0;

  // Affected users — call the Discover-style search for unique users.
  const affectedUsers = await fetchAffectedUsers(hours);

  return { count, prevCount, affectedUsers: affectedUsers ?? 0 };
}

function sumGroups(stats: SentryStatsV2): number {
  return stats.groups.reduce((total, g) => total + (g.totals['sum(quantity)'] ?? 0), 0);
}

/**
 * Unique users who experienced at least one error in the window.
 * Sentry tracks this per-issue; we sum the unique user counts on the
 * issues list. NOT perfectly accurate (the same user across multiple
 * issues gets counted twice — Sentry's UI does proper dedup that
 * isn't easily exposed via the API), but close enough for a pulse
 * card directional read.
 */
async function fetchAffectedUsers(hours: number): Promise<number | null> {
  const env = getEnv();
  if (!env) return null;
  const data = await sentryFetch<Array<{ userCount?: number }>>(
    `/projects/${env.org}/${env.project}/issues/`,
    {
      statsPeriod: `${hours}h`,
      query:       'is:unresolved',
      limit:       100,
    },
  );
  if (!data || !Array.isArray(data)) return null;
  return data.reduce((sum, issue) => sum + (issue.userCount ?? 0), 0);
}

// ── Releases ──────────────────────────────────────────────────────

export interface SentryRelease {
  version:    string;
  dateCreated: string; // ISO timestamp
}

/**
 * The most-recent release Sentry knows about. Used to surface "last
 * deploy 12m ago" on the pulse card. Null when none exists yet
 * (e.g. first Sentry-instrumented deploy hasn't happened).
 */
export async function fetchLastRelease(): Promise<SentryRelease | null> {
  const env = getEnv();
  if (!env) return null;
  const data = await sentryFetch<Array<{ version: string; dateCreated: string }>>(
    `/organizations/${env.org}/releases/`,
    {
      project: env.project,
      sort:    'date',
      per_page: 1,
    },
  );
  if (!data || data.length === 0) return null;
  return { version: data[0].version, dateCreated: data[0].dateCreated };
}
