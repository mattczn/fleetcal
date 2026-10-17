-- A name for a route (e.g. "Niagara → Costco 1118 shuttle") so it reads at
-- a glance instead of the auto-made place-to-place title. route_key is
-- the same ordered place ids joined by '>' as route_pay_standards.

CREATE TABLE IF NOT EXISTS route_names (
  id           bigserial   PRIMARY KEY,
  org_id       text        NOT NULL,
  route_key    text        NOT NULL,
  name         text        NOT NULL,
  set_by_name  text,
  set_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, route_key)
);

ALTER TABLE public.route_names ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "route_names_org_read" ON public.route_names;
CREATE POLICY "route_names_org_read" ON public.route_names
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);
