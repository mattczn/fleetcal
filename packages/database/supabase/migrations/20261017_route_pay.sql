-- Route pay: the places loads run between, and the standard driver pay
-- for each route (apps/api/src/lib/routePay.ts).
--
-- route_places: every pickup / delivery / handoff location, grouped so the
-- same dock is one place (stops within radius_mi of its point). Yards and
-- relay points are pinned to saved_locations. Created automatically from
-- stop history; names can be edited.
--
-- route_pay_standards: a standard pay for one route — the ordered places
-- of a leg, as route_places ids joined by '>'. A standard is what a leg on
-- that route should pay; the suggestion falls back to what payroll has
-- usually paid when there is none.

CREATE TABLE IF NOT EXISTS route_places (
  id                bigserial   PRIMARY KEY,
  org_id            text        NOT NULL,
  name              text        NOT NULL,
  lat               double precision NOT NULL,
  lng               double precision NOT NULL,
  radius_mi         numeric     NOT NULL DEFAULT 0.35,
  saved_location_id uuid        REFERENCES saved_locations(id) ON DELETE SET NULL,
  city              text,
  state             text,
  -- true once someone renames it (auto naming leaves it alone after that)
  named_by_user     boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_route_places_org ON route_places (org_id);

CREATE TABLE IF NOT EXISTS route_pay_standards (
  id              bigserial   PRIMARY KEY,
  org_id          text        NOT NULL,
  route_key       text        NOT NULL,
  amount          numeric     NOT NULL CHECK (amount >= 0),
  note            text,
  set_by          text,
  set_by_name     text,
  set_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, route_key)
);

ALTER TABLE public.route_places ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "route_places_org_read" ON public.route_places;
CREATE POLICY "route_places_org_read" ON public.route_places
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);

ALTER TABLE public.route_pay_standards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "route_pay_standards_org_read" ON public.route_pay_standards;
CREATE POLICY "route_pay_standards_org_read" ON public.route_pay_standards
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);
