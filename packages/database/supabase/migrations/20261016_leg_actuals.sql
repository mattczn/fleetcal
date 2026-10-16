-- 20261016_leg_actuals.sql
--
-- What each calendar leg actually took, measured from the truck's Motive
-- GPS by the movement linker (apps/api/src/lib/movementLinker.ts, spec in
-- docs/movement-linking.md). One row per leg, recomputed by the nightly
-- linker job; the per-drive links themselves live in movement_links.
--
-- Miles and hours here are the inputs the profitability model prices
-- with: loaded miles, deadhead into the leg, return to the overnight
-- park after it, dwell at its stops, rest on the road. `stops` keeps the
-- arrival / departure the GPS shows for each stop, and why a stop
-- couldn't be found.

CREATE TABLE IF NOT EXISTS leg_actuals (
  event_id        uuid        PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  org_id          text        NOT NULL,
  asset_id        bigint      REFERENCES assets(id) ON DELETE SET NULL,
  load_id         uuid        REFERENCES loads(id) ON DELETE CASCADE,

  -- 'rule_v1' today; AI review and manual fixes will write their own.
  source          text        NOT NULL,
  confidence      text        NOT NULL CHECK (confidence IN ('high','medium','low')),
  -- stop_not_found, stop_out_of_order, gps_gap, no_stops, miles_mismatch,
  -- detour, stop_no_coords …
  issues          text[]      NOT NULL DEFAULT '{}',

  route_miles     numeric,
  loaded_miles    numeric,
  loaded_hours    numeric,
  deadhead_miles  numeric,
  deadhead_hours  numeric,
  return_miles    numeric,
  return_hours    numeric,
  dwell_hours     numeric,
  rest_hours      numeric,

  -- The truck's time on this leg: leaving for its deadhead (or arriving
  -- at its first stop) through the end of its return (or leaving its
  -- last stop). Null when no stop was found.
  truck_start     timestamptz,
  truck_end       timestamptz,

  -- [{ stopId, kind, label, arrive, depart, distMi, offH, issue,
  --    nearest: {distMi, offH, at}, otherTrucks: [{assetId, name, arrive}] }]
  stops           jsonb       NOT NULL DEFAULT '[]'::jsonb,

  computed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leg_actuals_org_start
  ON leg_actuals (org_id, truck_start);

-- The review list: everything that isn't high confidence.
CREATE INDEX IF NOT EXISTS idx_leg_actuals_review
  ON leg_actuals (org_id, computed_at)
  WHERE confidence <> 'high';

CREATE INDEX IF NOT EXISTS idx_leg_actuals_load
  ON leg_actuals (load_id);

ALTER TABLE public.leg_actuals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leg_actuals_org_read" ON public.leg_actuals;
CREATE POLICY "leg_actuals_org_read" ON public.leg_actuals
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);
