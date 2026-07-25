-- 20260720_leg_index_and_handoff_photos.sql
--
-- N-leg relay support, part 1 (data model).
--
-- Relay legs are events sharing a load_id. Until now the shape was a hard
-- pair: relay_role 'pickup' | 'delivery'. To support N legs (multiple
-- drivers running segments of one revenue load) each event gains an
-- ordinal leg_index within its load:
--
--   leg 0 = origin leg ("Pickup"), leg N-1 = final leg ("Delivery"),
--   anything between = "Transfer". Roles/labels are DERIVED from position;
--   relay_role keeps being written for the first/last legs during the
--   transition so old readers (incl. the frozen legacy driver app) work.
--
-- Handoff photos: load_documents rows with kind='relay_handoff' were one
-- shared bucket per load. With multiple handoffs each exchange needs its
-- own photos. Stops can't key this (each leg carries its own COPY of the
-- relay stop rows, and stop rows are rebuilt on edit), so photos key on
-- handoff_index: the 0-based ordinal of the relay marker within the load's
-- stop sequence (handoff i sits between leg i and leg i+1). NULL means a
-- legacy pre-N-leg photo; readers should surface those on every handoff.

ALTER TABLE events ADD COLUMN IF NOT EXISTS leg_index integer;

UPDATE events
SET leg_index = CASE WHEN relay_role = 'delivery' THEN 1 ELSE 0 END
WHERE leg_index IS NULL;

ALTER TABLE events ALTER COLUMN leg_index SET DEFAULT 0;
ALTER TABLE events ALTER COLUMN leg_index SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_load_leg
  ON events (load_id, leg_index)
  WHERE load_id IS NOT NULL;

ALTER TABLE load_documents ADD COLUMN IF NOT EXISTS handoff_index integer;
