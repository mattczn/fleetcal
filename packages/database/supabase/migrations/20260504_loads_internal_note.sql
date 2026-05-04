-- Internal dispatch note pinned to a load. Distinct from loads.notes
-- (broker-context) and check_calls (timeline).

ALTER TABLE loads ADD COLUMN IF NOT EXISTS internal_note text;
