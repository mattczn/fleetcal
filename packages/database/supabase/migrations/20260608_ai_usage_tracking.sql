-- 20260608_ai_usage_tracking.sql
--
-- Track Anthropic API usage per organization so we can:
--   (a) see who's calling our AI surfaces and how much it costs,
--   (b) flag runaway loops / scripted abuse before the Anthropic
--       bill arrives,
--   (c) wire a per-org monthly cap with a clean 402 response when
--       crossed (PR 3 adds the gate; this migration is just the
--       data layer).
--
-- Two-table design:
--
--   ai_usage_logs     — append-only row per Anthropic API call.
--                       One parse-ratecon request that escalates to
--                       Sonnet (~5–10% of parses) writes two rows
--                       (one per pass). Indexed for org+time and
--                       endpoint+time scans. Plan to keep 90 days
--                       hot; a future cron archives/deletes older
--                       rows so the index stays small.
--
--   ai_usage_monthly  — denormalized per (org_id, ym, endpoint).
--                       Trigger maintained from ai_usage_logs so
--                       the dashboard + the soft monthly cap check
--                       in /api/parse-ratecon hit ONE row instead
--                       of summing the log table on every request.
--                       Permanent — survives log cleanup.
--
-- Both tables omit RLS (per the project-wide pattern — the API is
-- the gate, not the DB). They're scoped by `org_id` at the query
-- level by every consumer.

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id                          bigserial PRIMARY KEY,
  -- Clerk org id. Nullable so a future webhook / cron without an
  -- org context can still log (e.g. a system-wide health probe);
  -- monthly rollup ignores NULL rows.
  org_id                      text,
  -- Clerk user id. Nullable for the same reason. When set, drives
  -- the per-user breakdown in the admin dashboard so we can spot
  -- "one dispatcher in a tight reparse loop" vs "org-wide spike".
  user_id                     text,
  -- Logical endpoint, NOT the URL path. So a single route that
  -- makes multiple Anthropic calls (parse-ratecon = pass1 + pass2)
  -- still reports the same endpoint, while distinct features
  -- (cost-analysis, timeline-link) keep separate buckets.
  endpoint                    text NOT NULL,
  -- Model id, NOT the family ("claude-haiku-4-5-20251001", not
  -- "haiku"). Lets us re-cost old rows after Anthropic pricing
  -- shifts: the per-row cost_usd snapshot is correct at the time
  -- of the call; recomputing from token counts uses model id as
  -- the lookup key in lib/aiPricing.ts.
  model                       text NOT NULL,
  -- Which pass within the endpoint. parse-ratecon uses 1 for the
  -- Haiku first pass, 2 for the conditional Sonnet correction.
  -- Single-call endpoints stay on 1.
  pass                        int  NOT NULL DEFAULT 1,
  -- Anthropic usage fields. All ints; nullable on failed calls
  -- where the response never came back.
  input_tokens                int,
  output_tokens               int,
  cache_creation_input_tokens int,
  cache_read_input_tokens     int,
  -- Cost snapshot at the time of the call, computed in
  -- lib/aiPricing.ts. numeric(10,6) gives ~$9,999.999999 — plenty
  -- of headroom for a single call and small enough that sums
  -- across millions of rows fit cleanly.
  cost_usd                    numeric(10,6),
  -- Wall-clock latency of the Anthropic call (ms). Lets us spot
  -- model degradation independently from token cost.
  latency_ms                  int,
  -- Size of the inbound payload to OUR route (parse-ratecon: PDF
  -- bytes; cost-analysis: serialized loads list). Helps separate
  -- "user uploaded a 50-page rate con" from "user is hammering us
  -- with empty requests".
  request_bytes               int,
  -- Did the Anthropic call return cleanly. A `false` row with no
  -- token columns is a pre-flight failure (rate-limit gate, JSON
  -- parse, etc.); a `false` with tokens is an Anthropic-side
  -- error after billing.
  success                     boolean NOT NULL,
  -- Short tag for the error, so dashboard can group by error_code
  -- without parsing free text. Examples: 'rate_limit_org_minute',
  -- 'monthly_cap_exceeded', 'anthropic_5xx', 'json_parse_fail'.
  error_code                  text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- Hot index for the per-org dashboard view (most-recent-first).
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_org_time
  ON ai_usage_logs (org_id, created_at DESC);

-- Cross-org "what happened today" view (admin dashboard's
-- anomalies tab + the daily flag-sweep cron).
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_time
  ON ai_usage_logs (created_at DESC);

-- Per-endpoint slice — used by the org detail page's endpoint
-- breakdown and the per-minute rate-limit lookback.
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_org_endpoint_time
  ON ai_usage_logs (org_id, endpoint, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- Denormalized monthly rollup.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_usage_monthly (
  org_id        text NOT NULL,
  -- Calendar month key. `to_char(now() at time zone 'utc', 'YYYY-MM')`.
  -- UTC keeps the rollup unambiguous; PRs upstream may render in
  -- org-local time for display, but the bucket boundary is UTC so
  -- the cap-reset moment is a single global clock tick.
  ym            text NOT NULL,
  endpoint      text NOT NULL,
  call_count    int    NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  -- Timestamp the daily cron set when this row crossed a threshold
  -- (cap %, anomaly multiplier, etc.). Cleared by an admin from
  -- /admin/ai-usage when reviewed.
  flagged_at    timestamptz,
  -- First call recorded against this (org, ym, endpoint). Lets the
  -- dashboard show "active since…" without scanning the logs table.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Most recent call. Updated by the trigger below.
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, ym, endpoint)
);

-- Dashboard's top-spenders sort + the over-cap-check are both
-- "find the row with the largest cost_usd in this month". This
-- index keeps that O(log n).
CREATE INDEX IF NOT EXISTS idx_ai_usage_monthly_ym_cost
  ON ai_usage_monthly (ym, cost_usd DESC);

-- ─────────────────────────────────────────────────────────────
-- Trigger: keep ai_usage_monthly in sync with ai_usage_logs.
-- ─────────────────────────────────────────────────────────────
-- We do the rollup in-DB so the API code stays a single insert.
-- An app-side aggregation would double the write count, race on
-- concurrent inserts, and need careful retry handling on failure.
-- The trigger gives us atomic increments for free.
--
-- Skip rows with no org_id (system-level logs). Skip the
-- aggregation cost for failed pre-flight rows where token counts
-- are all NULL — they're useful in the log table for forensics
-- but contribute nothing to the rollup.
CREATE OR REPLACE FUNCTION ai_usage_logs_rollup()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_ym text;
BEGIN
  -- Skip system/non-org rows; they wouldn't have a useful org bucket.
  IF NEW.org_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_ym := to_char(NEW.created_at AT TIME ZONE 'utc', 'YYYY-MM');

  INSERT INTO ai_usage_monthly AS m (
    org_id, ym, endpoint,
    call_count, input_tokens, output_tokens, cost_usd,
    first_seen_at, last_seen_at
  ) VALUES (
    NEW.org_id, v_ym, NEW.endpoint,
    1,
    COALESCE(NEW.input_tokens, 0),
    COALESCE(NEW.output_tokens, 0),
    COALESCE(NEW.cost_usd, 0),
    NEW.created_at, NEW.created_at
  )
  ON CONFLICT (org_id, ym, endpoint) DO UPDATE
    SET call_count    = m.call_count    + 1,
        input_tokens  = m.input_tokens  + COALESCE(EXCLUDED.input_tokens,  0),
        output_tokens = m.output_tokens + COALESCE(EXCLUDED.output_tokens, 0),
        cost_usd      = m.cost_usd      + COALESCE(EXCLUDED.cost_usd,      0),
        last_seen_at  = NEW.created_at;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_usage_logs_rollup_trg
AFTER INSERT ON ai_usage_logs
FOR EACH ROW EXECUTE FUNCTION ai_usage_logs_rollup();
