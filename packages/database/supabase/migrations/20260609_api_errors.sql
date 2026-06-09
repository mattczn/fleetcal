-- /admin/errors backing table.
--
-- Every API response with status >= 400 (except /v1/health and binary
-- upload endpoints) gets one row inserted by the captureErrors Hono
-- middleware in apps/api/src/middleware/captureErrors.ts. The
-- middleware fires AFTER the route handler runs, so org_id and user_id
-- are populated whenever Clerk auth succeeded — which is most cases
-- because 401/403 are also captured here (Clerk auth-failure path
-- sets them to null).
--
-- Why a table and not just logs:
--   - searchable by org_id (the "matt's org is hitting 402s" case)
--   - drill-downable from /admin/errors with the same Clerk JWT
--     already gating the rest of admin
--   - cheaper than scraping Railway logs (Railway free tier truncates,
--     and grep-via-CLI is awful UX in a hurry)
--
-- Retention: nothing automatic. If this table grows large we'll add
-- a cron to drop rows older than N days. At Curzon scale (single
-- carrier) expected volume is ~10s of errors/day; <100k rows/year.

CREATE TABLE IF NOT EXISTS api_errors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- Both nullable: auth-failure errors (401/403) won't have these set.
  org_id        text,
  user_id       text,
  method        text NOT NULL,           -- GET / POST / PATCH / DELETE
  path          text NOT NULL,           -- /v1/assets, /v1/loads/...
  status        int  NOT NULL,           -- 400, 402, 500, etc.
  -- Parsed from JSON response body if present. e.g. 'validation_failed',
  -- 'tier_cap_exceeded'. Helps grouping at a glance.
  error_code    text,
  -- One-line human description (also from JSON body, often the same
  -- string we send the dispatcher).
  detail        text,
  -- First ~500 chars of the request body. Truncated server-side. Skipped
  -- entirely for multipart uploads (file content shouldn't land here).
  body_snippet  text,
  user_agent    text,
  duration_ms   int
);

-- RLS off — this is admin-only, accessed via service-role from
-- /api/admin/errors. Matches the project-wide pattern.
ALTER TABLE api_errors DISABLE ROW LEVEL SECURITY;

-- Most queries scan recent-first.
CREATE INDEX IF NOT EXISTS api_errors_occurred_idx
  ON api_errors (occurred_at DESC);

-- "Show me everything this org has hit lately."
CREATE INDEX IF NOT EXISTS api_errors_org_idx
  ON api_errors (org_id, occurred_at DESC);

-- Status-family filter (4xx vs 5xx) wants this. Composite with
-- occurred_at so the index serves both the filter and the sort.
CREATE INDEX IF NOT EXISTS api_errors_status_idx
  ON api_errors (status, occurred_at DESC);
