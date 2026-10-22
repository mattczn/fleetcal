-- Standard pay by area: areas drawn on a map (polygons) and the pay for a
-- leg from one area to another by kind (apps/api/src/lib/payAreas.ts).
--
-- pay_areas: a named polygon. A stop inside two areas belongs to the
-- smaller one, so a tight area around one facility can sit inside a
-- metro area. is_home marks where trucks are based: a lane leaving a home
-- area is outbound, one coming back is inbound.
-- pay_lanes: pay for a leg whose first stop is in from_area and last stop
-- in to_area, by kind: pickup (shipper → yard), delivery (yard →
-- consignee), whole (shipper → consignee), transfer (yard → yard only).
-- extra_stop: pay per stop past two on this lane (null = the general
-- extra-stop amount).

CREATE TABLE IF NOT EXISTS pay_areas (
  id               bigserial   PRIMARY KEY,
  org_id           text        NOT NULL,
  name             text        NOT NULL,
  color            text        NOT NULL DEFAULT '#1a73e8',
  polygon          jsonb       NOT NULL,
  is_home          boolean     NOT NULL DEFAULT false,
  updated_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pay_areas_org ON pay_areas (org_id);

CREATE TABLE IF NOT EXISTS pay_lanes (
  id            bigserial   PRIMARY KEY,
  org_id        text        NOT NULL,
  from_area_id  bigint      NOT NULL REFERENCES pay_areas(id) ON DELETE CASCADE,
  to_area_id    bigint      NOT NULL REFERENCES pay_areas(id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('pickup','delivery','whole','transfer')),
  amount        numeric     NOT NULL CHECK (amount >= 0),
  extra_stop    numeric     CHECK (extra_stop >= 0),
  note          text,
  set_by_name   text,
  set_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, from_area_id, to_area_id, kind)
);

ALTER TABLE public.pay_areas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pay_areas_org_read" ON public.pay_areas;
CREATE POLICY "pay_areas_org_read" ON public.pay_areas
  FOR SELECT TO authenticated USING ((auth.jwt() ->> 'org_id') = org_id);

ALTER TABLE public.pay_lanes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pay_lanes_org_read" ON public.pay_lanes;
CREATE POLICY "pay_lanes_org_read" ON public.pay_lanes
  FOR SELECT TO authenticated USING ((auth.jwt() ->> 'org_id') = org_id);
