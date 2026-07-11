-- 20260713_rule_asset_scope.sql
--
-- Asset-aware auto-file rules. A rule can now require that the txn's
-- memo matcher resolved a truck ('truck'), a trailer ('trailer'), or
-- nothing ('none') before it fires — 'any' (default) keeps today's
-- behavior. Lets maintenance spend auto-split into Maintenance →
-- Trucks / Trailers sub-buckets off the same category pattern, driven
-- by the unit tag the memo policy already produces.

ALTER TABLE ramp_category_rules
  ADD COLUMN IF NOT EXISTS asset_scope text NOT NULL DEFAULT 'any';

ALTER TABLE ramp_category_rules
  DROP CONSTRAINT IF EXISTS ramp_category_rules_asset_scope_chk;

ALTER TABLE ramp_category_rules
  ADD CONSTRAINT ramp_category_rules_asset_scope_chk
  CHECK (asset_scope IN ('any', 'truck', 'trailer', 'none'));
