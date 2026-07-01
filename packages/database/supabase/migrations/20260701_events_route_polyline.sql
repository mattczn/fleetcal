-- Cache the routed road geometry per event so the driver/dispatch/web map
-- views can draw the route from a stored polyline instead of each client
-- calling Google Directions on every map open. Populated server-side
-- (compute-on-read) via Mapbox Directions — see apps/api/src/lib/routeGeometry.ts.
--
--   route_polyline   Encoded polyline (Google/OSRM precision-5, `geometries=polyline`)
--                    of the simplified driving route through the event's geocoded
--                    stops. Precision-5 so it is directly usable by Google Static
--                    Maps `path=enc:` on mobile thumbnails. Nullable — stays null
--                    until the first detail read computes it (or when <2 stops are
--                    geocoded).
--   route_stops_key  The `lat,lng|lat,lng|…` signature of the geocoded stops that
--                    produced route_polyline. Compute-on-read compares the current
--                    signature against this; when stops change the key no longer
--                    matches and the polyline (+ loaded_miles) is recomputed. This
--                    self-invalidates the cache without hooking every stop-save path.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS route_polyline  text,
  ADD COLUMN IF NOT EXISTS route_stops_key text;
