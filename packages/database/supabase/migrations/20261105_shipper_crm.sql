-- 20261105_shipper_crm.sql
--
-- Shipper CRM: the carrier's own shipper / receiver / warehouse outreach
-- surface. Distinct from the internal `crm_*` sales tables (FleetCal
-- selling TO carriers) — this is a carrier prospecting the facilities IT
-- hauls for, built on top of the lane history it already has.
--
-- There is NO facilities roster to maintain. Facilities are COMPUTED from
-- the stops we already geocode, deduped by location (rounded lat/lng ≈
-- 111 m bucket = the geo_key). A "visit" is counted once per (load,
-- stop-type): relay legs carry the full stop list, so the same stop shows
-- up on every leg, and counting raw stop rows over-counts frequency by up
-- to 3× for busy facilities (measured on Curzon prod). The frequency that
-- drives "who do we call first" has to be deduped, so the rollup keys on
-- distinct (load_id, type).
--
-- The only STORED state is the human outreach layer — status, follow-up
-- date, contact, notes, and a call/email timeline — which lands in two
-- tables created lazily the first time someone acts on a facility. A
-- facility with no row is implicitly a `prospect`.
--
-- Three functions do the computation (all read-only, called by the API
-- with the service key so RLS doesn't apply to them):
--   fleetcal_geo_key(lat,lng) → the dedup identity, used everywhere so the
--                               rollup, the detail query, and the stored
--                               row all agree on one string per location.
--   facilities_rollup(org)    → every facility + its lane stats, as one
--                               jsonb array. Returning jsonb (not a set)
--                               sidesteps PostgREST's 1000-row read cap —
--                               there are ~1,300 facilities for Curzon.
--   facility_loads(org,geoKey)→ the loads we've run through one facility.

-- ── Geo-key helper ─────────────────────────────────────────────────────
-- 3 decimals ≈ 111 m. Chosen over 2 decimals (~1.1 km, which would merge
-- genuinely different businesses in one industrial park) — keeping
-- distinct companies distinct matters more for a prospecting list than
-- merging the occasional >111 m campus. IMMUTABLE so it can sit in an
-- index expression later if the stop volume ever makes that worth it.
CREATE OR REPLACE FUNCTION fleetcal_geo_key(p_lat double precision, p_lng double precision)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT round(p_lat::numeric, 3)::text || ',' || round(p_lng::numeric, 3)::text;
$$;

-- ── facilities (stored outreach state, one row per location) ───────────

CREATE TABLE IF NOT EXISTS facilities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         text NOT NULL,

  -- Identity: the rounded "lat,lng" from fleetcal_geo_key. The row is
  -- created from the geo_key the client got out of the rollup, so it lines
  -- back up with the computed facility exactly.
  geo_key        text NOT NULL,

  -- Snapshot of the facility's identity at first touch, so the outreach
  -- row still renders if the facility later drops out of the lane history
  -- (and so a list read doesn't have to re-run the rollup to label a row).
  name           text,
  address        text,
  city           text,
  state          text,
  lat            double precision,
  lng            double precision,

  status         text NOT NULL DEFAULT 'prospect'
                   CHECK (status IN ('prospect','contacted','in_talks','active','not_now','do_not_contact')),
  next_action_at timestamptz,
  owner_user_id  text,                 -- clerk user id handling this facility
  contact_name   text,
  contact_phone  text,
  contact_email  text,
  notes          text,

  -- User marked it not-a-prospect (own yard, a relay point we geocoded,
  -- etc.) so the prospect view can hide it without deleting the history.
  hidden         boolean NOT NULL DEFAULT false,

  -- Denormalized from facility_activities for list display + sorting, the
  -- same way crm_leads carries call_attempts / last-contact.
  call_attempts     integer NOT NULL DEFAULT 0,
  last_contacted_at timestamptz,
  last_call_outcome text
                   CHECK (last_call_outcome IS NULL OR last_call_outcome IN
                     ('no_answer','voicemail','gatekeeper','spoke','interested','not_interested','callback')),

  created_by     text,                 -- clerk user id
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- One outreach row per physical location per org.
  CONSTRAINT facilities_org_geo_key_uniq UNIQUE (org_id, geo_key)
);

CREATE INDEX IF NOT EXISTS facilities_org_status_idx
  ON facilities (org_id, status);
CREATE INDEX IF NOT EXISTS facilities_org_next_action_idx
  ON facilities (org_id, next_action_at)
  WHERE next_action_at IS NOT NULL;

DROP TRIGGER IF EXISTS facilities_updated_at ON facilities;
CREATE TRIGGER facilities_updated_at BEFORE UPDATE ON facilities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── facility_activities (append-only outreach timeline) ────────────────

CREATE TABLE IF NOT EXISTS facility_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,
  facility_id   uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  kind          text NOT NULL
                  CHECK (kind IN ('note','status_change','call','email','meeting','system')),
  body          text,
  -- Structured call result; null for non-call kinds.
  outcome       text
                  CHECK (outcome IS NULL OR outcome IN
                    ('no_answer','voicemail','gatekeeper','spoke','interested','not_interested','callback')),
  meta          jsonb,                -- e.g. {"from":"prospect","to":"contacted"} for status_change
  actor_user_id text,                 -- clerk user id; null = system
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS facility_activities_org_facility_idx
  ON facility_activities (org_id, facility_id, created_at DESC);

-- ── RLS ────────────────────────────────────────────────────────────────
-- Same org-scoped posture as every other core table (20260611_rls_lockdown).
-- The API writes with the service key and scopes by org_id in every query;
-- these policies cover any direct client read against a Clerk session token.

ALTER TABLE public.facilities          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facility_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "facilities_org_rw" ON public.facilities;
CREATE POLICY "facilities_org_rw" ON public.facilities
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

DROP POLICY IF EXISTS "facility_activities_org_rw" ON public.facility_activities;
CREATE POLICY "facility_activities_org_rw" ON public.facility_activities
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ── facilities_rollup(org) → jsonb array of every facility + stats ─────

CREATE OR REPLACE FUNCTION facilities_rollup(p_org_id text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT
      fleetcal_geo_key(st.lat, st.lng) AS geo_key,
      st.facility_name, st.address, st.city, st.state, st.lat, st.lng, st.type,
      ev.load_id, ev.start AS visit_at
    FROM stops st
    JOIN events ev ON ev.id = st.event_id
    WHERE st.org_id = p_org_id
      AND ev.deleted_at IS NULL
      AND st.lat IS NOT NULL AND st.lng IS NOT NULL
      -- shippers / receivers / plain stops only; relay + drop + drop_hook
      -- are our own operational points, not facilities to contact.
      AND st.type IN ('pickup','delivery','stop')
      AND ev.load_id IS NOT NULL
  ),
  -- Relay dedup: one visit per (location, type, load).
  visits AS (
    SELECT geo_key, type, load_id, min(visit_at) AS visit_at
    FROM base
    GROUP BY geo_key, type, load_id
  ),
  grp AS (
    SELECT
      geo_key,
      count(*)                                    AS visit_count,
      count(*) FILTER (WHERE type = 'pickup')     AS pickup_count,
      count(*) FILTER (WHERE type = 'delivery')   AS delivery_count,
      count(DISTINCT load_id)                     AS load_count,
      min(visit_at)                               AS first_seen,
      max(visit_at)                               AS last_seen
    FROM visits
    GROUP BY geo_key
  ),
  meta AS (
    SELECT geo_key, avg(lat) AS lat, avg(lng) AS lng
    FROM base GROUP BY geo_key
  ),
  -- Canonical label = the most common non-null (name, address, city, state)
  -- tuple among the bucket's named stops, so name + address stay consistent.
  label_rank AS (
    SELECT geo_key, facility_name, address, city, state,
           row_number() OVER (PARTITION BY geo_key
             ORDER BY count(*) DESC, facility_name) AS rn
    FROM base
    WHERE nullif(trim(facility_name), '') IS NOT NULL
    GROUP BY geo_key, facility_name, address, city, state
  ),
  labels AS (
    SELECT geo_key, facility_name AS name, address, city, state
    FROM label_rank WHERE rn = 1
  ),
  -- Fallback city/state for buckets whose stops never carried a name.
  city_fallback AS (
    SELECT geo_key,
           mode() WITHIN GROUP (ORDER BY nullif(trim(city), ''))        AS city,
           mode() WITHIN GROUP (ORDER BY upper(nullif(trim(state), ''))) AS state
    FROM base GROUP BY geo_key
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'geoKey',         g.geo_key,
    'name',           l.name,
    'address',        l.address,
    'city',           coalesce(l.city, cf.city),
    'state',          coalesce(l.state, cf.state),
    'lat',            round(m.lat::numeric, 6),
    'lng',            round(m.lng::numeric, 6),
    'visitCount',     g.visit_count,
    'pickupCount',    g.pickup_count,
    'deliveryCount',  g.delivery_count,
    'loadCount',      g.load_count,
    'firstSeen',      g.first_seen,
    'lastSeen',       g.last_seen,
    'internalGuess',  (coalesce(l.name, '') ILIKE '%yard%'
                       OR coalesce(l.name, '') ILIKE '%relay%'
                       OR coalesce(l.name, '') ILIKE '%terminal%')
  ) ORDER BY g.visit_count DESC), '[]'::jsonb)
  FROM grp g
  JOIN meta m USING (geo_key)
  LEFT JOIN labels l USING (geo_key)
  LEFT JOIN city_fallback cf USING (geo_key);
$$;

-- ── facility_loads(org, geoKey) → jsonb array of loads at one facility ──

CREATE OR REPLACE FUNCTION facility_loads(p_org_id text, p_geo_key text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT
      ev.load_id, ev.start AS visit_at, st.type,
      ld.internal_load_id,
      coalesce(ld.load_num,   ev.load_num)   AS load_num,
      coalesce(ld.broker,     ev.broker)     AS broker,
      coalesce(ld.load_price, ev.load_price) AS load_price
    FROM stops st
    JOIN events ev ON ev.id = st.event_id
    LEFT JOIN loads ld ON ld.id = ev.load_id
    WHERE st.org_id = p_org_id
      AND ev.deleted_at IS NULL
      AND st.lat IS NOT NULL AND st.lng IS NOT NULL
      AND fleetcal_geo_key(st.lat, st.lng) = p_geo_key
      AND ev.load_id IS NOT NULL
  ),
  per_load AS (
    SELECT
      load_id,
      min(visit_at)                                          AS visit_at,
      max(internal_load_id)                                  AS internal_load_id,
      (array_agg(load_num) FILTER (WHERE load_num IS NOT NULL))[1] AS load_num,
      (array_agg(broker)   FILTER (WHERE broker   IS NOT NULL))[1] AS broker,
      max(load_price)                                        AS load_price,
      bool_or(type = 'pickup')                               AS picked_up,
      bool_or(type = 'delivery')                             AS delivered
    FROM base GROUP BY load_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'loadId',         load_id,
    'internalLoadId', internal_load_id,
    'loadNum',        load_num,
    'broker',         broker,
    'loadPrice',      load_price,
    'visitAt',        visit_at,
    'role',           CASE WHEN picked_up AND delivered THEN 'both'
                           WHEN picked_up THEN 'shipper'
                           WHEN delivered THEN 'receiver'
                           ELSE 'stop' END
  ) ORDER BY visit_at DESC NULLS LAST), '[]'::jsonb)
  FROM per_load;
$$;

-- ── Enable the module for Curzon ───────────────────────────────────────
-- shipper_crm is default-OFF (DEFAULT_OFF_MODULES) so it stays dark for
-- every other org until turned on in /admin/orgs. Merge, don't replace,
-- so Curzon's other module flags survive.
INSERT INTO org_settings (org_id, modules)
VALUES ('org_3Ck09w6LuEjiX4WgxJEPyiyjuXN', '{"shipper_crm": true}'::jsonb)
ON CONFLICT (org_id) DO UPDATE
  SET modules = coalesce(org_settings.modules, '{}'::jsonb) || '{"shipper_crm": true}'::jsonb;
