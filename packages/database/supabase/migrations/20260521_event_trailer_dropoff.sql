-- 20260521_event_trailer_dropoff.sql
--
-- Add trailer-dropoff location columns to events. Used by the relay
-- handoff flow on the driver app: the pickup leg's driver captures
-- their phone's GPS the moment they leave the trailer, and the
-- delivery leg's driver sees that pin so they can find the trailer
-- at the handoff lot.
--
-- All three columns are null for non-relay events and stay null on
-- relay-pickup events until the driver explicitly hits "Save Trailer
-- Location" — the planned stop coords already exist on stops.lat/lng
-- and aren't trustworthy as an "actual drop" position.
--
-- Storage is intentionally on events (not load_documents or a new
-- table) — one pin per event, exactly the cardinality of the leg
-- itself. A new pin overwrites the old one; we don't need history.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS trailer_dropoff_lat  double precision,
  ADD COLUMN IF NOT EXISTS trailer_dropoff_lng  double precision,
  ADD COLUMN IF NOT EXISTS trailer_dropoff_at   timestamptz;

-- Index isn't worth it — these columns are only read on the
-- single-row driver load-detail query that already filters by event
-- id (primary key). Skipping.
