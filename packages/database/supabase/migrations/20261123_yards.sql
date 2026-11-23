-- Yards = a saved location that owns a radius.
--
-- Dispatch already keeps the places it cares about in saved_locations
-- ("SLC Yard" has been a row there since the HOS work, and the home
-- terminal reads from it). A yard is not a different kind of thing
-- from one of those; it is one of those with an answer to "how close
-- counts as here". So this is a column, not a table: no second place
-- to name the same point, no drift between a preset and a yard that
-- are supposed to be the same gate.
--
-- NULL radius = an ordinary saved location, which is every existing
-- row. Nothing changes until someone sets one.
--
-- Stored in METRES because that is what Google Maps' Circle takes and
-- what a haversine returns; the UI talks feet, since a yard is a few
-- hundred of those and nobody pictures 305 m.

alter table saved_locations
  add column if not exists radius_meters integer;

alter table saved_locations
  drop constraint if exists saved_locations_radius_meters_sane;

-- A yard with a radius of 0 would match nothing and a radius of 50 km
-- would swallow the valley; both are typos rather than intent. The
-- ceiling is deliberately generous (~31 miles) so a carrier using this
-- for a whole metro still fits.
alter table saved_locations
  add constraint saved_locations_radius_meters_sane
  check (radius_meters is null or (radius_meters > 0 and radius_meters <= 50000));

-- A yard is only usable as a geofence if it has a point to centre on.
-- This is advisory rather than a constraint: existing rows may have a
-- name and address but no geocode yet, and refusing those outright
-- would block setting a radius before the address resolves.
comment on column saved_locations.radius_meters is
  'Geofence radius in metres. Non-null makes this location a "yard": the trailer map draws it and trailers inside it report as parked there. Needs lat/lng to have any effect.';
