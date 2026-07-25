-- 20260724_handoff_on_any_stop.sql
--
-- N-leg relay support, part 2 (handoff boundaries).
--
-- Until now a leg boundary could only be a dedicated `type='relay'`
-- stop. Real relays don't work that way: a driver often ends their leg
-- AT a real stop — "leg 1 picks up in Vegas and delivers in Hurricane,
-- leg 2 takes it from Hurricane onward". Forcing a separate relay stop
-- at the same address duplicates the row and reads as two stops.
--
-- So a handoff becomes a FLAG that any stop can carry:
--
--   is_handoff = true  → this stop is the boundary between the leg that
--                        ends here and the leg that starts here.
--   type='relay'       → still implicitly a handoff (legacy + the case
--                        where the handoff point is a bare trailer drop
--                        that isn't a pickup/delivery in its own right).
--
-- Readers must use the isHandoffStop() helper in @fleetcal/types rather
-- than checking type='relay' directly.
--
-- Handoff times: relay-type stops keep using appt_start/appt_end (driver
-- 1 drops / driver 2 picks up), which is what every existing reader
-- expects. A handoff on a REAL stop can't reuse those — they already
-- hold that stop's own appointment window — so it gets its own pair.
-- handoffTimesOf() normalizes the two cases.

ALTER TABLE stops ADD COLUMN IF NOT EXISTS is_handoff        boolean NOT NULL DEFAULT false;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS handoff_drop_at   text;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS handoff_pickup_at text;

-- No backfill: existing relay-type stops are handoffs by definition via
-- the helper, and leaving is_handoff false on them keeps the flag
-- meaning exactly "handoff on a stop that isn't a relay point".

CREATE INDEX IF NOT EXISTS idx_stops_handoff
  ON stops (event_id, sequence)
  WHERE is_handoff;
