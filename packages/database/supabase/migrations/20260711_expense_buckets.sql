-- 20260711_expense_buckets.sql
--
-- Phase E for /expenses: buckets themselves become user-editable data.
--
--   * NEW expense_buckets table (2-level tree per org). Row per bucket
--     with name, icon, color, sort_order, and an optional system_role
--     that flags which top-level bucket receives auto-injected data
--     (driver pay + adjustments, Mudflap fuel).
--   * bucket_id (uuid FK) added to recurring_expenses, expense_entries,
--     ramp_transactions, ramp_category_rules — replaces bucket_key
--     (text enum) as the source of truth for routing.
--   * Every org that already has expense data gets seeded with the
--     8 default buckets so their existing rows can be backfilled
--     without a UI trip.
--   * bucket_key CHECK constraints are dropped from all 4 tables;
--     the column stays for backward-compat but writes will populate
--     bucket_id going forward.

-- ─── expense_buckets ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expense_buckets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL,
  -- NULL parent = top-level (tile on the dashboard). Otherwise this is
  -- a sub-bucket within the parent (drill-in row). 2-level depth is
  -- enforced in the API — nothing here prevents a child of a child.
  parent_id    uuid REFERENCES expense_buckets(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  -- lucide-react icon name (e.g. "Users", "Truck"). NULL → generic icon.
  icon         text,
  color        text,
  sort_order   integer NOT NULL DEFAULT 0,
  -- 'driver_pay' → this bucket receives events.driver_pay + payroll_adjustments
  -- 'mudflap_fuel' → this bucket receives fuel_transactions.total_charged
  -- Only top-level buckets can carry a system_role.
  system_role  text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  CONSTRAINT expense_buckets_no_self_parent CHECK (parent_id IS NULL OR parent_id != id),
  CONSTRAINT expense_buckets_system_role_top_level_only
    CHECK (system_role IS NULL OR parent_id IS NULL),
  CONSTRAINT expense_buckets_system_role_values
    CHECK (system_role IS NULL OR system_role IN ('driver_pay', 'mudflap_fuel'))
);

-- Only one bucket per org can hold each system role. NULLs are
-- excluded from the partial unique so multiple non-system buckets
-- coexist.
CREATE UNIQUE INDEX IF NOT EXISTS expense_buckets_org_system_role_uidx
  ON expense_buckets (org_id, system_role)
  WHERE system_role IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS expense_buckets_org_parent_sort_idx
  ON expense_buckets (org_id, parent_id, sort_order)
  WHERE deleted_at IS NULL;

CREATE TRIGGER expense_buckets_updated_at
  BEFORE UPDATE ON expense_buckets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.expense_buckets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expense_buckets_org_rw" ON public.expense_buckets
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ─── seed defaults for every org that already has expense data ────────

-- One-shot: for each distinct org_id that shows up anywhere in the
-- expense stack, materialize the 8 default top-level buckets. Uses a
-- WITH-clause CTE + CROSS JOIN so the 8-row template is inserted per
-- org, skipping any org that already has a bucket (idempotent).

WITH orgs_with_data AS (
  SELECT DISTINCT org_id FROM recurring_expenses WHERE deleted_at IS NULL
  UNION SELECT DISTINCT org_id FROM expense_entries WHERE deleted_at IS NULL
  UNION SELECT DISTINCT org_id FROM ramp_transactions WHERE deleted_at IS NULL
  UNION SELECT DISTINCT org_id FROM ramp_category_rules WHERE deleted_at IS NULL
),
orgs_without_buckets AS (
  SELECT o.org_id FROM orgs_with_data o
  WHERE NOT EXISTS (
    SELECT 1 FROM expense_buckets b
    WHERE b.org_id = o.org_id AND b.deleted_at IS NULL
  )
),
defaults(name, legacy_key, icon, sort_order, system_role) AS (
  VALUES
    ('Payroll & People',    'payroll_people',    'Users',       10, 'driver_pay'),
    ('Fleet Operations',    'fleet_ops',         'Truck',       20, 'mudflap_fuel'),
    ('Facilities',          'facilities',        'Building2',   30, NULL),
    ('Insurance & Claims',  'insurance_claims',  'ShieldCheck', 40, NULL),
    ('Software & Overhead', 'software_overhead', 'Cpu',         50, NULL),
    ('Capex',               'capex',             'Wrench',      60, NULL),
    ('Taxes',               'taxes',             'Landmark',    70, NULL),
    ('Owner Draws',         'owner_draws',       'HandCoins',   80, NULL)
)
INSERT INTO expense_buckets (org_id, name, icon, sort_order, system_role)
SELECT o.org_id, d.name, d.icon, d.sort_order, d.system_role
FROM orgs_without_buckets o CROSS JOIN defaults d;

-- ─── add bucket_id columns to referencing tables + backfill ───────────

ALTER TABLE recurring_expenses    ADD COLUMN IF NOT EXISTS bucket_id uuid;
ALTER TABLE expense_entries       ADD COLUMN IF NOT EXISTS bucket_id uuid;
ALTER TABLE ramp_transactions     ADD COLUMN IF NOT EXISTS bucket_id uuid;
ALTER TABLE ramp_category_rules   ADD COLUMN IF NOT EXISTS bucket_id uuid;

-- Backfill helper: map legacy bucket_key text values to the seeded
-- bucket_id per org. Runs once — later rows write bucket_id directly.
WITH key_to_bucket AS (
  SELECT b.id AS bucket_id, b.org_id,
    CASE b.name
      WHEN 'Payroll & People'    THEN 'payroll_people'
      WHEN 'Fleet Operations'    THEN 'fleet_ops'
      WHEN 'Facilities'          THEN 'facilities'
      WHEN 'Insurance & Claims'  THEN 'insurance_claims'
      WHEN 'Software & Overhead' THEN 'software_overhead'
      WHEN 'Capex'               THEN 'capex'
      WHEN 'Taxes'               THEN 'taxes'
      WHEN 'Owner Draws'         THEN 'owner_draws'
    END AS legacy_key
  FROM expense_buckets b
  WHERE b.parent_id IS NULL AND b.deleted_at IS NULL
)
UPDATE recurring_expenses re
  SET bucket_id = k.bucket_id
  FROM key_to_bucket k
  WHERE re.org_id = k.org_id
    AND re.bucket_key = k.legacy_key
    AND re.bucket_id IS NULL;

WITH key_to_bucket AS (
  SELECT b.id AS bucket_id, b.org_id,
    CASE b.name
      WHEN 'Payroll & People'    THEN 'payroll_people'
      WHEN 'Fleet Operations'    THEN 'fleet_ops'
      WHEN 'Facilities'          THEN 'facilities'
      WHEN 'Insurance & Claims'  THEN 'insurance_claims'
      WHEN 'Software & Overhead' THEN 'software_overhead'
      WHEN 'Capex'               THEN 'capex'
      WHEN 'Taxes'               THEN 'taxes'
      WHEN 'Owner Draws'         THEN 'owner_draws'
    END AS legacy_key
  FROM expense_buckets b
  WHERE b.parent_id IS NULL AND b.deleted_at IS NULL
)
UPDATE expense_entries ee
  SET bucket_id = k.bucket_id
  FROM key_to_bucket k
  WHERE ee.org_id = k.org_id
    AND ee.bucket_key = k.legacy_key
    AND ee.bucket_id IS NULL;

WITH key_to_bucket AS (
  SELECT b.id AS bucket_id, b.org_id,
    CASE b.name
      WHEN 'Payroll & People'    THEN 'payroll_people'
      WHEN 'Fleet Operations'    THEN 'fleet_ops'
      WHEN 'Facilities'          THEN 'facilities'
      WHEN 'Insurance & Claims'  THEN 'insurance_claims'
      WHEN 'Software & Overhead' THEN 'software_overhead'
      WHEN 'Capex'               THEN 'capex'
      WHEN 'Taxes'               THEN 'taxes'
      WHEN 'Owner Draws'         THEN 'owner_draws'
    END AS legacy_key
  FROM expense_buckets b
  WHERE b.parent_id IS NULL AND b.deleted_at IS NULL
)
UPDATE ramp_transactions rt
  SET bucket_id = k.bucket_id
  FROM key_to_bucket k
  WHERE rt.org_id = k.org_id
    AND rt.bucket_key = k.legacy_key
    AND rt.bucket_id IS NULL;

WITH key_to_bucket AS (
  SELECT b.id AS bucket_id, b.org_id,
    CASE b.name
      WHEN 'Payroll & People'    THEN 'payroll_people'
      WHEN 'Fleet Operations'    THEN 'fleet_ops'
      WHEN 'Facilities'          THEN 'facilities'
      WHEN 'Insurance & Claims'  THEN 'insurance_claims'
      WHEN 'Software & Overhead' THEN 'software_overhead'
      WHEN 'Capex'               THEN 'capex'
      WHEN 'Taxes'               THEN 'taxes'
      WHEN 'Owner Draws'         THEN 'owner_draws'
    END AS legacy_key
  FROM expense_buckets b
  WHERE b.parent_id IS NULL AND b.deleted_at IS NULL
)
UPDATE ramp_category_rules rc
  SET bucket_id = k.bucket_id
  FROM key_to_bucket k
  WHERE rc.org_id = k.org_id
    AND rc.bucket_key = k.legacy_key
    AND rc.bucket_id IS NULL;

-- Enforce bucket_id NOT NULL on the tables where the legacy bucket_key
-- was NOT NULL. Ramp txn bucket_id stays nullable (Uncategorized).
ALTER TABLE recurring_expenses  ALTER COLUMN bucket_id SET NOT NULL;
ALTER TABLE expense_entries     ALTER COLUMN bucket_id SET NOT NULL;
ALTER TABLE ramp_category_rules ALTER COLUMN bucket_id SET NOT NULL;
-- ramp_transactions.bucket_id stays nullable — NULL = Uncategorized CTA

ALTER TABLE recurring_expenses    ADD CONSTRAINT recurring_expenses_bucket_fk  FOREIGN KEY (bucket_id) REFERENCES expense_buckets(id) ON DELETE RESTRICT;
ALTER TABLE expense_entries       ADD CONSTRAINT expense_entries_bucket_fk    FOREIGN KEY (bucket_id) REFERENCES expense_buckets(id) ON DELETE RESTRICT;
ALTER TABLE ramp_transactions     ADD CONSTRAINT ramp_transactions_bucket_fk  FOREIGN KEY (bucket_id) REFERENCES expense_buckets(id) ON DELETE SET NULL;
ALTER TABLE ramp_category_rules   ADD CONSTRAINT ramp_category_rules_bucket_fk FOREIGN KEY (bucket_id) REFERENCES expense_buckets(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS recurring_expenses_bucket_idx  ON recurring_expenses  (org_id, bucket_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS expense_entries_bucket_idx     ON expense_entries     (org_id, bucket_id, date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ramp_transactions_bucket_id_idx ON ramp_transactions (org_id, bucket_id, transacted_at DESC) WHERE bucket_id IS NOT NULL AND deleted_at IS NULL;

-- ─── drop legacy bucket_key CHECK constraints (columns stay) ──────────

ALTER TABLE recurring_expenses  DROP CONSTRAINT IF EXISTS recurring_expenses_bucket_check;
ALTER TABLE expense_entries     DROP CONSTRAINT IF EXISTS expense_entries_bucket_check;
ALTER TABLE ramp_transactions   DROP CONSTRAINT IF EXISTS ramp_transactions_bucket_check;
ALTER TABLE ramp_category_rules DROP CONSTRAINT IF EXISTS ramp_category_rules_bucket_check;
