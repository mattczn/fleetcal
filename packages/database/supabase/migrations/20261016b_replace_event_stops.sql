-- Atomic stop replacement for a load's legs.
--
-- Why
-- ---
-- Every API path that edits a load's stops (PUT /v1/events/:id/stops,
-- PUT /v1/loads/:id/legs, POST /v1/loads/:id/split-relay) used to do
-- two separate PostgREST calls: DELETE every stop on the event, then
-- INSERT the new list. Anything that made the insert fail left the
-- load with zero stops and no way back — stops are hard-deleted.
--
-- The insert failed deterministically on PUT /v1/events/:id/stops
-- whenever a driver had checked in at SOME but not all stops. That
-- route re-sent `id` only for checked-in stops; supabase-js turns a
-- bulk insert with mixed keys into `columns=<union>` with missing
-- values as NULL (defaultToNull), so the un-checked-in rows carried
-- id = NULL → 23502 → 500 after the delete. Railway's HTTP log for
-- 2026-10-06..16 has eight 500s on that route; all eight loads are
-- stopless today. 113 revenue legs since 2026-07-01 are stopless.
--
-- What this does
-- --------------
-- One transaction per call. For each target event, each incoming stop
-- is matched to an existing stop on that event and UPDATED IN PLACE;
-- unmatched incoming stops are inserted; existing stops nothing
-- matched are deleted. Updating in place (instead of delete+insert)
-- keeps:
--   • the stop uuid the driver app holds (check-in POSTs by stop id),
--   • arrived_at / arrived_lat / arrived_lng (never written here),
--   • movement_links.dwell_stop_id rows (FK ON DELETE CASCADE).
--
-- Matching an incoming stop with id X on event L:
--   1. L has a stop with id X → that stop.
--   2. X is a stop on ANOTHER target event (relay legs all carry the
--      full stop list, and the client sends one leg's ids) → the stop
--      on L at the same sequence with the same type / address /
--      facility as X had before this call.
--   3. otherwise → new row.
-- Each existing stop is claimed at most once, so a payload that
-- repeats an id gets a new row for the repeat instead of a PK clash.
--
-- Refuses (and changes nothing) when the list is empty, a stop has no
-- type, or any target event is not in the org.
--
-- Callable only by service_role (the API). Apply BEFORE deploying the
-- API that calls it.

CREATE OR REPLACE FUNCTION replace_event_stops(
  p_org_id    text,
  p_event_ids uuid[],
  p_stops     jsonb
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_events  uuid[];
  v_old     stops[];
  v_event   uuid;
  v_elem    jsonb;
  v_ord     bigint;
  v_id_text text;
  v_id      uuid;
  v_in      stops;
  v_anchor  stops;
  v_match   uuid;
  v_keep    uuid[];
  v_written integer := 0;
BEGIN
  IF p_stops IS NULL OR jsonb_typeof(p_stops) <> 'array' OR jsonb_array_length(p_stops) = 0 THEN
    RAISE EXCEPTION 'stops cannot be empty — a load must have at least one stop'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT e) INTO v_events FROM unnest(p_event_ids) AS e;
  IF v_events IS NULL THEN
    RAISE EXCEPTION 'no events given' USING ERRCODE = '22023';
  END IF;

  -- Lock the target events so two saves of the same load serialize
  -- rather than interleave their reads and writes.
  PERFORM 1 FROM events WHERE id = ANY(v_events) AND org_id = p_org_id FOR UPDATE;
  IF (SELECT count(*) FROM events WHERE id = ANY(v_events) AND org_id = p_org_id)
     <> cardinality(v_events) THEN
    RAISE EXCEPTION 'event not found' USING ERRCODE = 'P0002';
  END IF;

  -- Snapshot before any write: matching reads this, never the live
  -- rows, so updates made for one leg can't skew another leg's match.
  SELECT coalesce(array_agg(s), '{}') INTO v_old
  FROM stops s
  WHERE s.event_id = ANY(v_events) AND s.org_id = p_org_id;

  FOREACH v_event IN ARRAY v_events LOOP
    v_keep := '{}';

    FOR v_elem, v_ord IN
      SELECT value, ordinality FROM jsonb_array_elements(p_stops) WITH ORDINALITY
    LOOP
      -- Client ids for brand-new stops aren't always uuids; treat
      -- anything else as "no id". Server-owned columns are stripped so
      -- a payload can never write a check-in or move a stop.
      v_id_text := v_elem->>'id';
      v_id := CASE
        WHEN v_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN v_id_text::uuid
      END;
      v_in := jsonb_populate_record(
        NULL::stops,
        v_elem - 'id' - 'event_id' - 'org_id' - 'sequence'
               - 'arrived_at' - 'arrived_lat' - 'arrived_lng'
               - 'created_at' - 'updated_at'
      );
      IF v_in.type IS NULL OR btrim(v_in.type) = '' THEN
        RAISE EXCEPTION 'stop % has no type', v_ord USING ERRCODE = '22023';
      END IF;

      v_match := NULL;
      IF v_id IS NOT NULL THEN
        SELECT o.id INTO v_match
        FROM unnest(v_old) AS o
        WHERE o.id = v_id AND o.event_id = v_event AND NOT (o.id = ANY(v_keep));

        IF v_match IS NULL THEN
          SELECT o.* INTO v_anchor FROM unnest(v_old) AS o WHERE o.id = v_id;
          IF FOUND THEN
            SELECT o.id INTO v_match
            FROM unnest(v_old) AS o
            WHERE o.event_id = v_event
              AND o.sequence = v_anchor.sequence
              AND o.type = v_anchor.type
              AND o.address IS NOT DISTINCT FROM v_anchor.address
              AND o.facility_name IS NOT DISTINCT FROM v_anchor.facility_name
              AND NOT (o.id = ANY(v_keep))
            ORDER BY o.created_at
            LIMIT 1;
          END IF;
        END IF;
      END IF;

      IF v_match IS NOT NULL THEN
        UPDATE stops SET
          sequence          = v_ord,
          type              = v_in.type,
          facility_name     = v_in.facility_name,
          address           = v_in.address,
          city              = v_in.city,
          state             = v_in.state,
          timezone          = v_in.timezone,
          appt_start        = v_in.appt_start,
          appt_end          = v_in.appt_end,
          schedule_type     = v_in.schedule_type,
          is_handoff        = coalesce(v_in.is_handoff, false),
          handoff_drop_at   = v_in.handoff_drop_at,
          handoff_pickup_at = v_in.handoff_pickup_at,
          lat               = v_in.lat,
          lng               = v_in.lng,
          instructions      = v_in.instructions,
          geocode_status    = coalesce(v_in.geocode_status, 'pending')
        WHERE id = v_match;
      ELSE
        INSERT INTO stops (
          event_id, org_id, sequence, type, facility_name, address, city, state,
          timezone, appt_start, appt_end, schedule_type, is_handoff,
          handoff_drop_at, handoff_pickup_at, lat, lng, instructions, geocode_status
        ) VALUES (
          v_event, p_org_id, v_ord, v_in.type, v_in.facility_name, v_in.address, v_in.city, v_in.state,
          v_in.timezone, v_in.appt_start, v_in.appt_end, v_in.schedule_type, coalesce(v_in.is_handoff, false),
          v_in.handoff_drop_at, v_in.handoff_pickup_at, v_in.lat, v_in.lng, v_in.instructions,
          coalesce(v_in.geocode_status, 'pending')
        )
        RETURNING id INTO v_match;
      END IF;

      v_keep := v_keep || v_match;
      v_written := v_written + 1;
    END LOOP;

    DELETE FROM stops
    WHERE event_id = v_event AND org_id = p_org_id AND NOT (id = ANY(v_keep));
  END LOOP;

  RETURN v_written;
END;
$$;

REVOKE ALL ON FUNCTION replace_event_stops(text, uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION replace_event_stops(text, uuid[], jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
