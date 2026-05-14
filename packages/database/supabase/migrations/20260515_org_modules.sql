-- 20260515_org_modules.sql
--
-- Add `modules` jsonb to org_settings to support the SaaS module
-- toggle layer (separate from role capabilities). Each entry is a
-- boolean flag for a top-level feature module that an org's plan
-- can include or exclude:
--
--   closeout    — POD verification queue
--   accounting  — billing pipeline + invoices
--   fuel        — driver fuel-up reports
--   payroll     — per-driver weekly pay + adjustments
--   maintenance — maintenance reports + action items
--
-- The default is everything ENABLED so existing orgs (and any org
-- that signs up before billing is wired through) don't lose access
-- to features they already use. Per-org overrides are written by an
-- admin in Settings → Modules, and (Phase 2) by Stripe subscription
-- webhooks that toggle modules based on the org's plan.
--
-- Missing key in the JSONB is treated as ENABLED by the helper in
-- `packages/types/modules.ts`, so future additions to the module list
-- ship with implicit-on semantics until billing toggles them.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS modules jsonb NOT NULL
    DEFAULT '{"closeout":true,"accounting":true,"fuel":true,"payroll":true,"maintenance":true}'::jsonb;

-- Backfill any pre-existing rows (in case the table was already
-- populated before this column was added). Safe to re-run.
UPDATE org_settings
   SET modules = '{"closeout":true,"accounting":true,"fuel":true,"payroll":true,"maintenance":true}'::jsonb
 WHERE modules IS NULL;
