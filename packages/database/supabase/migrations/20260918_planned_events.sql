-- 20260918_planned_events.sql
--
-- Planned events: a dispatcher's placeholder on a truck's calendar for
-- work that isn't booked yet — "find a load SLC → Vegas for Kevin",
-- "ITS National load expected Monday", "reposition to Vegas empty".
--
-- WHY A NEW TABLE rather than a third events.event_kind: almost every
-- reader of `events` decides "is this a real load?" with
-- `event_kind !== 'non_revenue'`, so a new kind would silently count as
-- revenue in fleet utilization, timeline profitability, payroll rows,
-- the public capacity stat, and the Motive movement linker. Worse, the
-- driver API lists every event carrying a driver_id, the confirm-
-- reminder job pushes on any scheduled event with a driver, and the
-- driver app's realtime channel subscribes to the whole events table
-- for the org. A plan must never reach a driver. Keeping plans out of
-- `events` makes every one of those paths safe by construction instead
-- of by remembering to add a filter in ~35 places.
--
-- A plan is closed by attaching the real load it turned into
-- (converted_at + converted_load_id). "Expired" is NOT stored — it's derived at read
-- time (end + 24h in the past, no load attached), so there is no cron
-- to run and nothing to drift.

CREATE TABLE IF NOT EXISTS planned_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            text NOT NULL,

  asset_id          bigint NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  driver_id         bigint REFERENCES drivers(id) ON DELETE SET NULL,

  -- find_load | expected_load | reposition. Drives the block's title
  -- prefix only; kept a CHECK so a typo can't invent a fourth purpose.
  purpose           text NOT NULL DEFAULT 'find_load'
                    CHECK (purpose IN ('find_load', 'expected_load', 'reposition')),
  title             text NOT NULL,
  notes             text,

  -- Same format as events.start / events."end": naive local time
  -- 'YYYY-MM-DDTHH:mm' in the org's home timezone, so a plan sits on
  -- the calendar exactly where a load with the same times would.
  start             text NOT NULL,
  "end"             text NOT NULL,

  -- Set when the plan is fulfilled. converted_at is the "closed" flag
  -- (the plan leaves the calendar once it's set); converted_load_id is
  -- the link, and may go NULL later if that load is hard-deleted —
  -- which must not resurrect the plan.
  converted_load_id uuid REFERENCES loads(id) ON DELETE SET NULL,
  converted_at      timestamptz,

  created_by        text,
  created_by_name   text,

  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT planned_events_span_valid CHECK ("end" > start)
);

CREATE INDEX IF NOT EXISTS planned_events_org_idx
  ON planned_events (org_id, "end")
  WHERE deleted_at IS NULL AND converted_at IS NULL;

CREATE INDEX IF NOT EXISTS planned_events_asset_idx
  ON planned_events (asset_id);

DROP TRIGGER IF EXISTS planned_events_updated_at ON planned_events;
CREATE TRIGGER planned_events_updated_at BEFORE UPDATE ON planned_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────
-- Same posture as the rest of the schema (see 20260611_rls_lockdown):
-- the API writes with the service key and scopes by org_id; this
-- policy covers direct client reads against a Clerk session token.
-- The driver app authenticates natively (no Clerk org_id claim), so it
-- cannot read this table directly.
ALTER TABLE public.planned_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "planned_events_org_rw" ON public.planned_events;
CREATE POLICY "planned_events_org_rw" ON public.planned_events
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);
