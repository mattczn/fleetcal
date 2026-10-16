-- 20261016b_link_reviews.sql
--
-- Review history for the movement linker (docs/movement-linking.md).
-- Append-only: every time a person marks a leg's GPS linking right or
-- wrong, or asks the AI to explain it, one row lands here with a snapshot
-- of the leg_actuals row they were looking at. The latest human row is
-- the leg's current verdict; the full history is the training set for
-- tuning the rules and for the AI's "what the reviewer told us before".

CREATE TABLE IF NOT EXISTS link_reviews (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           text        NOT NULL,
  event_id         uuid        NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- 'human' = a reviewer's verdict; 'ai' = an AI explanation.
  kind             text        NOT NULL CHECK (kind IN ('human','ai')),
  -- Human only.
  verdict          text        CHECK (verdict IN ('correct','wrong')),
  -- Human: what was wrong (wrong_truck, stop_pin_wrong, wrong_stop_matched,
  -- calendar_time_wrong, missing_stops, miles_wrong, other).
  -- AI: its likely cause.
  reason           text,
  note             text,
  -- AI: { summary, cause, fix, suggestedTruck, confidence, model }.
  suggestion       jsonb,
  -- The leg_actuals row as it was when reviewed.
  snapshot         jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_by       text,
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT link_reviews_verdict_kind CHECK (kind = 'ai' OR verdict IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_link_reviews_event
  ON link_reviews (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_reviews_org
  ON link_reviews (org_id, kind, created_at DESC);

ALTER TABLE public.link_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "link_reviews_org_read" ON public.link_reviews;
CREATE POLICY "link_reviews_org_read" ON public.link_reviews
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);
