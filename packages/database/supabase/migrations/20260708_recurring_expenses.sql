-- 20260708_recurring_expenses.sql
--
-- Phase B for the /expenses dashboard: recurring charges (weekly W-2
-- salaries for admin/dispatch/maintenance staff, monthly insurance
-- premiums). Stored as rules with an effective date range, not
-- materialized per-period rows — the summary endpoint prorates into
-- any requested window at query time. Editing a rate (raise Anna's
-- pay from $1500 → $1600) applies from the change date forward, no
-- backfill needed.
--
-- The `kind` column is open-coded text with a CHECK. New categories
-- (equipment_rental in a later phase) get added to the CHECK; the
-- dashboard's bucket routing keys off the same enum.
--
-- Also: soft CHECK on ramp_transactions.expense_category so bad
-- values can't sneak in via the manual reassign UI or an over-eager
-- auto-mapper. Nullable so uncategorized txns keep flowing.

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          text NOT NULL,

  -- 'payroll_admin' | 'payroll_dispatch' | 'payroll_maintenance' | 'insurance'
  -- Widened when equipment rentals ship (Phase B+1).
  kind            text NOT NULL
                    CHECK (kind IN
                      ('payroll_admin','payroll_dispatch','payroll_maintenance','insurance')),
  -- Human-readable label ("Anna – admin", "Progressive commercial auto").
  label           text NOT NULL,
  amount          numeric(12, 2) NOT NULL,
  -- 'weekly' | 'monthly'
  cadence         text NOT NULL
                    CHECK (cadence IN ('weekly','monthly')),
  effective_from  date NOT NULL,
  effective_to    date,       -- NULL = open-ended (active until edited/ended)
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  -- Guard against zero-length or backwards ranges.
  CONSTRAINT recurring_expenses_range_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- Active-rule lookups for the summary rollup — the most common query is
-- "rules active during this window". Partial to keep it cheap once
-- ended rules pile up.
CREATE INDEX IF NOT EXISTS recurring_expenses_org_active_idx
  ON recurring_expenses (org_id, kind, effective_from)
  WHERE deleted_at IS NULL;

CREATE TRIGGER recurring_expenses_updated_at
  BEFORE UPDATE ON recurring_expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.recurring_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "recurring_expenses_org_rw" ON public.recurring_expenses
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ─── expense_category enum tightening ───────────────────────────────
--
-- Adds a soft CHECK so the manual dropdown + auto-mapper can only
-- write approved values. Nullable stays: uncategorized rows are a
-- first-class state on the board.

ALTER TABLE ramp_transactions
  ADD CONSTRAINT ramp_transactions_expense_category_chk
  CHECK (expense_category IS NULL OR expense_category IN
    ('maintenance','load_expenses','hotels','fuel','office','other'));
