-- 20260915_timesheets.sql
--
-- Shop timesheets: clock in / clock out for non-driver staff, with a
-- location ping every ~10 minutes while the clock is running.
--
-- WHY A NEW TABLE rather than reusing hos_shifts: hos_shifts is a
-- compliance record for DRIVERS under 49 CFR 395 — it is keyed by
-- driver_id, feeds the rolling 70/8 cycle, and carries a retention
-- duty. A mechanic clocking in is a payroll record keyed by Clerk
-- user_id with no cycle math behind it. Sharing the table would mean
-- every HOS query has to learn to exclude rows that aren't driving
-- time, which is exactly the kind of quiet contamination that makes a
-- compliance number wrong.
--
-- The overlap constraint and soft-delete design below are lifted
-- deliberately from 20260913b_hos_no_overlap.sql. The reasoning
-- transfers: these rows are what someone gets PAID from, so a doubled
-- hour is a real-money error, and a guard that lives only in one code
-- path is one direct write away from being bypassed.

-- ── timesheet_shifts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS timesheet_shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      text NOT NULL,

  -- Clerk user id. NOT drivers.id — the people using this are shop
  -- staff who have a login but no driver record.
  user_id     text NOT NULL,
  -- Denormalized display name, same pattern as
  -- maintenance_action_items.created_by_name. Clerk is the source of
  -- truth; this keeps a timesheet readable without an API round-trip
  -- per row, and keeps history intact if someone leaves the org.
  user_name   text,

  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,

  -- Where the punch happened. Nullable because a punch must never be
  -- blocked by a denied or slow location fix — an hour recorded
  -- without coordinates beats an hour not recorded at all.
  start_lat   numeric(9,6),
  start_lng   numeric(9,6),
  end_lat     numeric(9,6),
  end_lng     numeric(9,6),

  notes       text,

  -- Set when the client notices background location has stopped
  -- delivering (iOS "Always" downgraded to "While Using", or the user
  -- revoked it mid-shift). Without this, a shift with no pings after
  -- 9:15am is indistinguishable from someone who stood still all
  -- afternoon — the reviewer needs to be able to tell those apart.
  tracking_stopped_at timestamptz,

  -- Who last corrected the times by hand, and when. A reviewer fixing
  -- a forgotten clock-out is expected; it just shouldn't be silent.
  edited_by   text,
  edited_at   timestamptz,

  -- Pay records are soft-deleted, never dropped. Same stance as
  -- hos_shifts: if a removal turns out to be wrong, the hours are
  -- still recoverable.
  deleted_at  timestamptz,
  deleted_by  text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- A shift may be open (ended_at null) but never backwards.
  CONSTRAINT timesheet_shifts_span_valid
    CHECK (ended_at IS NULL OR ended_at > started_at)
);

CREATE INDEX IF NOT EXISTS timesheet_shifts_org_idx
  ON timesheet_shifts (org_id, started_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS timesheet_shifts_user_idx
  ON timesheet_shifts (org_id, user_id, started_at DESC) WHERE deleted_at IS NULL;

-- One running clock per person. Partial-unique rather than an
-- application check so a retried clock-in on a flaky connection can't
-- open a second shift.
CREATE UNIQUE INDEX IF NOT EXISTS timesheet_shifts_one_open_per_user
  ON timesheet_shifts (org_id, user_id)
  WHERE ended_at IS NULL AND deleted_at IS NULL;

-- No overlapping paid time for the same person. btree_gist lets the
-- plain-equality user_id sit alongside the range-overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- '[)' bounds allow end-to-end adjacency: clocking straight back in at
-- the moment you clocked out is legitimate and must not be rejected.
-- An open shift extends to infinity, so nothing can be recorded after
-- an unclosed shift's start until that shift is closed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'timesheet_shifts_no_overlap'
  ) THEN
    ALTER TABLE timesheet_shifts
      ADD CONSTRAINT timesheet_shifts_no_overlap
      EXCLUDE USING gist (
        org_id  WITH =,
        user_id WITH =,
        tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)') WITH &&
      ) WHERE (deleted_at IS NULL);
  END IF;
END $$;

-- ── timesheet_pings ──────────────────────────────────────────────────
--
-- One row per background location sample while a shift is open.
CREATE TABLE IF NOT EXISTS timesheet_pings (
  id          bigserial PRIMARY KEY,
  shift_id    uuid NOT NULL REFERENCES timesheet_shifts(id) ON DELETE CASCADE,
  org_id      text NOT NULL,

  at          timestamptz NOT NULL,
  lat         numeric(9,6) NOT NULL,
  lng         numeric(9,6) NOT NULL,
  accuracy_m  numeric(7,1),

  created_at  timestamptz NOT NULL DEFAULT now(),

  -- IDEMPOTENCY, and the reason this table has a unique constraint at
  -- all. The phone buffers pings while offline (a shop is exactly
  -- where signal dies) and flushes them in a batch that may be retried
  -- after a timeout it never saw the response to. Without this, one
  -- retry duplicates every ping in the batch and the reviewer sees a
  -- dense cluster that looks like the person circled the block.
  -- Upload uses ON CONFLICT DO NOTHING against this key.
  CONSTRAINT timesheet_pings_unique_sample UNIQUE (shift_id, at)
);

CREATE INDEX IF NOT EXISTS timesheet_pings_shift_idx
  ON timesheet_pings (shift_id, at);

-- ── RLS ──────────────────────────────────────────────────────────────
--
-- Same posture as the rest of the schema (see 20260611_rls_lockdown):
-- the API writes with the service key and scopes by org_id in every
-- query; these policies cover direct client reads against a Clerk
-- session token carrying org_id.
--
-- NOTE: org-scoped, not user-scoped. Restricting a mechanic to their
-- OWN rows is the `timesheet.view_all` capability's job, enforced in
-- the API — putting it here too would break the reviewer's read, since
-- both users present the same org_id claim.
ALTER TABLE public.timesheet_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_pings  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "timesheet_shifts_org_rw" ON public.timesheet_shifts;
CREATE POLICY "timesheet_shifts_org_rw" ON public.timesheet_shifts
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

DROP POLICY IF EXISTS "timesheet_pings_org_rw" ON public.timesheet_pings;
CREATE POLICY "timesheet_pings_org_rw" ON public.timesheet_pings
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);
