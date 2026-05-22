-- 20260522_cost_analysis_reports.sql
--
-- Saved cost-analysis runs. Each row is one Claude call:
-- the date window analyzed, the structured per-load result, the
-- token counts, and metadata. Surfaces in the AssetDetailModal's
-- Cost tab — we auto-load the most recent row for a vehicle so
-- dispatchers see prior results immediately instead of re-running
-- the (slow, $$) Claude call every time they open the panel.
--
-- Stored as jsonb so the result schema can evolve without
-- migrations. Token counts captured so future analytics can show
-- average cost per run.

CREATE TABLE IF NOT EXISTS cost_analysis_reports (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text         NOT NULL,
  vehicle_id    bigint       NOT NULL,     -- Motive vehicle id
  asset_id      bigint,                    -- assets(id), denormalized for convenience
  window_from   timestamptz  NOT NULL,
  window_to     timestamptz  NOT NULL,
  result        jsonb        NOT NULL,     -- full tool input from Claude
  counts        jsonb,                     -- { movements, loads }
  usage         jsonb,                     -- { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
  model         text         NOT NULL,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  created_by    text                       -- Clerk user id (optional)
);

-- Primary query path: "give me the latest report for this vehicle."
CREATE INDEX IF NOT EXISTS idx_cost_analysis_vehicle_created
  ON cost_analysis_reports (vehicle_id, created_at DESC);

-- For org-wide history views later on.
CREATE INDEX IF NOT EXISTS idx_cost_analysis_org_created
  ON cost_analysis_reports (org_id, created_at DESC);
