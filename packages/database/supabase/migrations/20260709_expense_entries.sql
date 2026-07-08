-- 20260709_expense_entries.sql
--
-- Phase C for the /expenses dashboard: one-time / ad-hoc entries that
-- don't fit the recurring rules model (variable amounts, unpredictable
-- cadence, or truly one-off). Rules stay in recurring_expenses;
-- everything else — Sophia/Luis weekly owner-op payouts (variable
-- amount), Penske wire transfers for truck purchases, claim payouts,
-- Jon/Mike owner draws from the Chase Sapphire card, one-off tax
-- payments — lives here.
--
-- Also widens recurring_expenses.kind to cover the newly-modeled
-- recurring categories (yard rent, office rent, W-9 address stipends
-- for Andrew/Heidi, SaaS + load-board subscriptions).

-- ─── expense_entries table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expense_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL,

  -- Which /expenses bucket this posts into. Open-coded text + CHECK so
  -- new kinds slot in without breaking existing rows. Sub-taxonomy
  -- (e.g. tax_irp vs tax_ifta) can be encoded in label for now — we
  -- consolidate to a single 'tax' kind for the dashboard tile.
  kind         text NOT NULL
                 CHECK (kind IN (
                   'owner_op_payout',    -- Sophia/Luis weekly variable payouts
                   'claim_payout',       -- Accident/damage payouts
                   'truck_purchase',     -- Capex — Penske wires
                   'equipment_purchase', -- Capex — other equipment
                   'tax',                -- IRP, IFTA, income, state (specify in label)
                   'owner_draw',         -- Chase Sapphire / Jon+Mike withdrawals
                   'subscription',       -- One-off subs not covered by recurring
                   'misc'                -- Anything else, spelled out in label
                 )),

  date         date NOT NULL,
  amount       numeric(12, 2) NOT NULL,
  label        text NOT NULL,
  notes        text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,

  CONSTRAINT expense_entries_amount_positive
    CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS expense_entries_org_date_idx
  ON expense_entries (org_id, date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS expense_entries_org_kind_date_idx
  ON expense_entries (org_id, kind, date DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER expense_entries_updated_at
  BEFORE UPDATE ON expense_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.expense_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expense_entries_org_rw" ON public.expense_entries
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ─── widen recurring_expenses.kind ─────────────────────────────────────

ALTER TABLE recurring_expenses
  DROP CONSTRAINT IF EXISTS recurring_expenses_kind_check;

ALTER TABLE recurring_expenses
  ADD CONSTRAINT recurring_expenses_kind_check
  CHECK (kind IN (
    'payroll_admin', 'payroll_dispatch', 'payroll_maintenance',
    'insurance',
    'yard_rent',              -- monthly yard/lot lease
    'office_rent',            -- monthly office rent (may be owner-benefit)
    'address_stipend',        -- Andrew/Heidi $500/mo for address + check deposits
    'software_subscription'   -- SaaS + load board subs
  ));
