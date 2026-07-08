-- 20260710_dehardcode_expenses.sql
--
-- Phase D for the /expenses stack: drop hardcoded enums on kind /
-- expense_category so admins can categorize entries however they want.
-- The DASHBOARD structure (8 buckets) stays fixed because that's the
-- tile grid; sub-categorization inside a bucket becomes free-text.
--
-- Changes:
--   * recurring_expenses  — drop kind CHECK, make kind nullable free
--                           text, add bucket_key (CHECK against 8)
--   * expense_entries     — same shape as recurring_expenses
--   * ramp_transactions   — drop expense_category CHECK, add bucket_key
--                           (nullable — Ramp txns can stay uncategorized)
--   * ramp_category_rules — NEW table. User-editable regex → bucket
--                           mappings for the sync-time auto-categorizer.
--                           Replaces the hardcoded rampCategoryMap.ts
--                           (which becomes a seed-defaults source only).

-- ─── recurring_expenses ───────────────────────────────────────────────

ALTER TABLE recurring_expenses
  DROP CONSTRAINT IF EXISTS recurring_expenses_kind_check;

ALTER TABLE recurring_expenses
  ADD COLUMN IF NOT EXISTS bucket_key text;

UPDATE recurring_expenses
  SET bucket_key = CASE
    WHEN kind IN ('payroll_admin','payroll_dispatch','payroll_maintenance','address_stipend') THEN 'payroll_people'
    WHEN kind IN ('yard_rent','office_rent')                                                  THEN 'facilities'
    WHEN kind = 'insurance'                                                                    THEN 'insurance_claims'
    WHEN kind = 'software_subscription'                                                        THEN 'software_overhead'
    ELSE 'software_overhead'
  END
  WHERE bucket_key IS NULL;

ALTER TABLE recurring_expenses
  ALTER COLUMN bucket_key SET NOT NULL;

ALTER TABLE recurring_expenses
  ADD CONSTRAINT recurring_expenses_bucket_check
  CHECK (bucket_key IN (
    'payroll_people','fleet_ops','facilities','insurance_claims',
    'software_overhead','capex','taxes','owner_draws'
  ));

-- kind becomes an optional descriptive tag (no enum, no NOT NULL).
ALTER TABLE recurring_expenses
  ALTER COLUMN kind DROP NOT NULL;

-- ─── expense_entries ──────────────────────────────────────────────────

ALTER TABLE expense_entries
  DROP CONSTRAINT IF EXISTS expense_entries_kind_check;

ALTER TABLE expense_entries
  ADD COLUMN IF NOT EXISTS bucket_key text;

UPDATE expense_entries
  SET bucket_key = CASE
    WHEN kind = 'owner_op_payout'                    THEN 'payroll_people'
    WHEN kind = 'claim_payout'                       THEN 'insurance_claims'
    WHEN kind IN ('truck_purchase','equipment_purchase') THEN 'capex'
    WHEN kind = 'tax'                                THEN 'taxes'
    WHEN kind = 'owner_draw'                         THEN 'owner_draws'
    WHEN kind IN ('subscription','misc')             THEN 'software_overhead'
    ELSE 'software_overhead'
  END
  WHERE bucket_key IS NULL;

ALTER TABLE expense_entries
  ALTER COLUMN bucket_key SET NOT NULL;

ALTER TABLE expense_entries
  ADD CONSTRAINT expense_entries_bucket_check
  CHECK (bucket_key IN (
    'payroll_people','fleet_ops','facilities','insurance_claims',
    'software_overhead','capex','taxes','owner_draws'
  ));

ALTER TABLE expense_entries
  ALTER COLUMN kind DROP NOT NULL;

-- ─── ramp_transactions ────────────────────────────────────────────────

ALTER TABLE ramp_transactions
  DROP CONSTRAINT IF EXISTS ramp_transactions_expense_category_chk;

ALTER TABLE ramp_transactions
  ADD COLUMN IF NOT EXISTS bucket_key text;

UPDATE ramp_transactions
  SET bucket_key = CASE
    WHEN expense_category IN ('maintenance','load_expenses','hotels','fuel') THEN 'fleet_ops'
    WHEN expense_category = 'office'                                          THEN 'software_overhead'
    ELSE NULL   -- 'other' and unknowns start uncategorized
  END
  WHERE bucket_key IS NULL AND expense_category IS NOT NULL;

ALTER TABLE ramp_transactions
  ADD CONSTRAINT ramp_transactions_bucket_check
  CHECK (bucket_key IS NULL OR bucket_key IN (
    'payroll_people','fleet_ops','facilities','insurance_claims',
    'software_overhead','capex','taxes','owner_draws'
  ));

-- Partial index for the "route ramp spend to a bucket" query on the
-- summary endpoint. Cheap because most rows will be categorized.
CREATE INDEX IF NOT EXISTS ramp_transactions_bucket_idx
  ON ramp_transactions (org_id, bucket_key, transacted_at DESC)
  WHERE bucket_key IS NOT NULL AND deleted_at IS NULL;

-- expense_category stays for backward-compat + as a hint of Ramp's
-- original classification. New code writes bucket_key.

-- ─── ramp_category_rules ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ramp_category_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL,

  -- Pattern to match against ramp_transactions.sk_category_name.
  -- is_regex=true → JS regex string (i-case flag applied at match time).
  -- is_regex=false → substring match, case-insensitive.
  pattern      text NOT NULL,
  is_regex     boolean NOT NULL DEFAULT true,

  bucket_key   text NOT NULL,

  -- First match wins, lower priority = earlier. 100 = default. Users
  -- pin overrides at 10 to beat the seeded 100-priority defaults.
  priority     integer NOT NULL DEFAULT 100,

  notes        text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  CONSTRAINT ramp_category_rules_bucket_check
    CHECK (bucket_key IN (
      'payroll_people','fleet_ops','facilities','insurance_claims',
      'software_overhead','capex','taxes','owner_draws'
    ))
);

CREATE INDEX IF NOT EXISTS ramp_category_rules_org_priority_idx
  ON ramp_category_rules (org_id, priority ASC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER ramp_category_rules_updated_at
  BEFORE UPDATE ON ramp_category_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.ramp_category_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ramp_category_rules_org_rw" ON public.ramp_category_rules
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);
