-- 20261124b_vehicle_location_samples.sql
--
-- Truck position history, the sibling of trailer_location_samples.
--
-- WHY, specifically: to work out which trailer a truck is actually
-- pulling. Dispatch records both sides on only 26% of loads (225 of
-- 855 in the 30 days to 2026-11-23), so for three loads in four we
-- don't know which trailer went out. A truck and the trailer behind
-- it are in the same place, continuously, while moving — so the
-- pairing is recoverable from position alone.
--
-- A live check on 2026-11-23 showed the signal is there and is clean:
-- 11 of 17 trucks had a trailer within 150 m, and the distances were
-- bimodal — roughly 10–80 m, then nothing until 4 km, 51 km, 166 km,
-- 339 km. No ambiguous middle to tune a threshold through.
--
-- Two things that check also showed, which is why this table stores
-- history rather than the inference being done off live positions:
--   • Co-located is not hooked. Most of those 11 were parked in the
--     same yard on a Sunday night. Only co-movement OUTSIDE a yard,
--     sustained across several samples, means anything.
--   • Stale fixes lie. One "pair" rested on a trailer fix 16.5 days
--     old and another on a truck fix 8.8 days old. A rule has to
--     require both sides fresh at the same instant, which needs
--     timestamped history on both.
--
-- Deliberately a second table rather than a column on the trailer one:
-- the foreign keys differ (assets vs trailers), and a polymorphic
-- owner column would trade a real constraint for a self-join.
--
-- Same dedupe design as the trailer table: UNIQUE on Motive's fix
-- timestamp, not our poll time, so polling faster than a truck reports
-- costs nothing and a double-fire writes nothing.

CREATE TABLE IF NOT EXISTS vehicle_location_samples (
  id          bigserial   PRIMARY KEY,
  org_id      text        NOT NULL,
  asset_id    bigint      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  address     text,

  located_at  timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (asset_id, located_at)
);

-- "Newest N for one truck" — the detail read.
CREATE INDEX IF NOT EXISTS vehicle_location_samples_asset_time_idx
  ON vehicle_location_samples (org_id, asset_id, located_at DESC);

-- "Everything the fleet did in this window" — what the pairing
-- backtest sweeps, since it has to compare every truck against every
-- trailer at the same instants.
CREATE INDEX IF NOT EXISTS vehicle_location_samples_org_time_idx
  ON vehicle_location_samples (org_id, located_at DESC);

ALTER TABLE public.vehicle_location_samples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vehicle_location_samples_org_rw" ON public.vehicle_location_samples;
CREATE POLICY "vehicle_location_samples_org_rw" ON public.vehicle_location_samples
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

COMMENT ON TABLE vehicle_location_samples IS
  'Append-only GPS fixes per truck, one row per distinct Motive located_at. Written by the fleet-location sweep in apps/api alongside trailer_location_samples. Basis for inferring which trailer a truck is pulling.';
