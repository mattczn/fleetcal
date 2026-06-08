-- 20260608_cron_runs.sql
--
-- Heartbeat log for in-process cron jobs in apps/api/src/index.ts.
-- Without this, a silent cron failure (sweep crashes, Motive sync
-- stops mid-pass) is invisible until a customer complains a day
-- later. With it, the /admin/health dashboard can show "last
-- success per job" and surface a row turning red.
--
-- One row per RUN (not per job — runs accumulate). The dashboard
-- shows the most recent row per job_name; older rows form the
-- history that lets us answer "how often does runConfirmReminders
-- actually take >30s?"
--
-- Append-only. A future cron will trim rows older than 30 days so
-- the table stays under control. At ~6 jobs × 24 runs/day = ~150
-- rows/day, 30 days = ~4500 rows. Trivially small.

CREATE TABLE IF NOT EXISTS cron_runs (
  id           bigserial PRIMARY KEY,
  -- Stable name from the cron's setInterval handler. Matches the
  -- labels we already use in console logs (sweep-auto-deliver,
  -- confirm-reminders, motive-sync, odometer-snapshot,
  -- fuel-auto-match, ai-usage-sweep).
  job_name     text NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  duration_ms  int,
  success      boolean NOT NULL,
  -- Short stable error tag when success=false. Free text is fine
  -- but the dashboard groups by this, so keep it terse.
  error_code   text,
  -- Free-text error message + stack snippet. Truncated to ~500
  -- chars at the call site so a long stack trace doesn't bloat
  -- the row. Just enough to debug from the dashboard without
  -- digging through Railway logs.
  error_message text,
  -- Optional JSON metric bag — # of rows touched, # of orgs
  -- swept, etc. Lets each job pass back richer "what did this
  -- run actually do" data without a column-per-metric mess.
  meta         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Dashboard's "most recent run per job" query is `ORDER BY
-- started_at DESC LIMIT 1` per job_name — keep that O(log n).
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_time
  ON cron_runs (job_name, started_at DESC);

-- Cross-job recent activity (for the health-tab "last 24h" view).
CREATE INDEX IF NOT EXISTS idx_cron_runs_time
  ON cron_runs (started_at DESC);

ALTER TABLE cron_runs DISABLE ROW LEVEL SECURITY;
