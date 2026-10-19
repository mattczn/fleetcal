-- Rate card settings for suggested driver pay (apps/api/src/lib/rateCard.ts):
-- regions (e.g. SLC within 100 mi of the yard), distance bands, routes and
-- name patterns left out of training (DCL round trips), and cell overrides.

CREATE TABLE IF NOT EXISTS route_pay_config (
  org_id           text        PRIMARY KEY,
  config           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by_name  text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.route_pay_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "route_pay_config_org_read" ON public.route_pay_config;
CREATE POLICY "route_pay_config_org_read" ON public.route_pay_config
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);
