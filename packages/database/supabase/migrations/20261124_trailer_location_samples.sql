-- 20261124_trailer_location_samples.sql
--
-- Trailer location history, so "when did this trailer last MOVE?"
-- becomes answerable at all.
--
-- Today the trailer map reads Motive's /v1/asset_locations live and
-- keeps nothing. That endpoint answers two questions well — where is
-- it now, and when did the tracker last report (located_at) — and a
-- third one not at all: how long has it been sitting there. The third
-- is the one behind "has this trailer been stolen", and it is the only
-- one that cannot be reconstructed later. The only way to know where a
-- trailer was yesterday is to have written it down yesterday.
--
-- Measured on Curzon's live fleet (2026-11-23, 27 Motive-tracked
-- trailers): 20 of 27 had reported within 2 hours, the rest within 7,
-- and one reefer had not reported in 21 days. So a tracker refreshes
-- every few hours at worst while it is alive, and an hourly poll
-- cannot miss a move.
--
-- ── DEDUPE ON THE FIX, NOT THE POLL ─────────────────────────────────
--
-- UNIQUE (trailer_id, located_at) is the whole design. located_at is
-- Motive's timestamp for the GPS fix, not ours for the request, so
-- polling hourly against a tracker that reports every 4 hours inserts
-- one row and rejects three. Storage then tracks real fixes rather
-- than our poll cadence, and "last moved" can be computed by walking
-- consecutive samples without first having to smooth out repeats.
--
-- The cost of that is small enough to change the retention answer:
-- ~27 trailers x ~5 fixes a day is ~50k rows a year, a few MB. There
-- is no reason to throw away a 7-day window. The sweep prunes at two
-- years, purely so the table has a ceiling.

CREATE TABLE IF NOT EXISTS trailer_location_samples (
  id          bigserial   PRIMARY KEY,
  org_id      text        NOT NULL,
  trailer_id  bigint      NOT NULL REFERENCES trailers(id) ON DELETE CASCADE,

  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  -- Motive's reverse-geocoded label ("Salt Lake City, UT", or
  -- "3.3 mi SW of Cheyenne, WY" out in the open). Stored rather than
  -- re-geocoded later: it is what the dispatcher saw at the time, and
  -- re-deriving it would cost a Maps call per historical row.
  address     text,

  -- When MOTIVE says the fix was taken. The dedupe key, and the clock
  -- every "parked since" answer is measured on. Never now().
  located_at  timestamptz NOT NULL,
  -- Motive's own in-motion flag at the time of the fix. Not the basis
  -- for "has it moved" (a trailer can be moved between two fixes
  -- without either one catching it mid-roll) but useful for telling a
  -- genuinely rolling trailer from a parked one on sight.
  moving      boolean,

  -- When WE wrote the row. Diverges from located_at by up to the poll
  -- interval, and the gap is how a stalled tracker shows up: rows stop
  -- appearing while recorded_at would have kept advancing.
  recorded_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (trailer_id, located_at)
);

-- The access pattern is "newest N samples for one trailer", walked
-- backwards until the position differs enough to count as a move.
CREATE INDEX IF NOT EXISTS trailer_location_samples_trailer_time_idx
  ON trailer_location_samples (org_id, trailer_id, located_at DESC);

-- And "everything the fleet did in this window", for the prune and for
-- a whole-fleet history read.
CREATE INDEX IF NOT EXISTS trailer_location_samples_org_time_idx
  ON trailer_location_samples (org_id, located_at DESC);

ALTER TABLE public.trailer_location_samples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trailer_location_samples_org_rw" ON public.trailer_location_samples;
CREATE POLICY "trailer_location_samples_org_rw" ON public.trailer_location_samples
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

COMMENT ON TABLE trailer_location_samples IS
  'Append-only GPS fixes per trailer, one row per distinct Motive located_at. Written hourly by the trailer-location sweep in apps/api. Basis for "last moved" / "parked since" and the trailer-dark alert.';
