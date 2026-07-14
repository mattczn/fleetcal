-- 20260716_revenue_adjustments.sql
--
-- Manual revenue for periods the loads calendar doesn't cover — the
-- pre-system weeks of January 2026, where load revenue lived in a
-- spreadsheet. One row per (usually) week; folded into the /expenses
-- revenue meter alongside the live loads-report number. Deliberately
-- NOT surfaced in the dashboard's per-load reports (revenue-by-truck,
-- broker, etc.) — those stay strictly load-backed.

CREATE TABLE IF NOT EXISTS revenue_adjustments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      text NOT NULL,
  date        date NOT NULL,
  amount      numeric(12, 2) NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT revenue_adjustments_amount_nonzero CHECK (amount <> 0)
);

CREATE INDEX IF NOT EXISTS revenue_adjustments_org_date_idx
  ON revenue_adjustments (org_id, date)
  WHERE deleted_at IS NULL;

CREATE TRIGGER revenue_adjustments_updated_at
  BEFORE UPDATE ON revenue_adjustments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.revenue_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "revenue_adjustments_org_rw" ON public.revenue_adjustments
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);
