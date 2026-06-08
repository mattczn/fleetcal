-- 20260608_org_settings_ai_cap.sql
--
-- Per-org monthly AI spending cap for the parse-ratecon route's
-- pre-flight gate (PR 3 of the AI usage tracker).
--
--   org_settings.ai_monthly_cap_usd  — soft monthly ceiling in USD.
--     NULL = no per-org override; the gate falls back to a sensible
--     default in code (see apps/web/lib/aiUsage.ts). Set explicitly
--     to raise/lower the cap for a specific org (e.g. a big-fleet
--     customer who needs $200/mo, or a brand-new free-tier org
--     locked at $5/mo until they verify).
--
-- numeric(10,2) gives ~$99,999,999.99 — comically more headroom
-- than any monthly cap should ever need, but cheap to store and
-- forgiving against accidental dollars/cents confusion.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS ai_monthly_cap_usd numeric(10,2);

-- No backfill — every org starts at NULL (= use default in code).
-- A future admin UI in /admin/orgs can override per org without
-- another migration.
