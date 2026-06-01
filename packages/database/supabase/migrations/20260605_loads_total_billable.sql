-- 20260605_loads_total_billable.sql
--
-- Denormalize the "total billable to broker" amount onto loads.total_billable.
--
-- Until now, the invoice total has only existed at invoice-generation time
-- via buildSnapshot() in apps/api/src/routes/invoices.ts:314–342, which
-- computes:
--
--     totalCharges = load.load_price
--                  + sum(accessorials where billable !== false and amount > 0)
--
-- Every report that wants to show "what this load actually bills" has been
-- doing one of two wrong things:
--
--   1. Showing load_price only (closeout summary, accounting tables,
--      dashboard Gross Revenue KPI, performance RPM, payroll calc) — this
--      silently undercounts detention, lumper reimbursement, layover, etc.
--
--   2. Re-implementing the buildSnapshot math inline (a handful of UI
--      surfaces) — fine until somebody changes the math in one place and
--      not the other.
--
-- Storing the precomputed total on the load row eliminates both failure
-- modes. A BEFORE-trigger keeps it in sync whenever load_price or the
-- accessorials jsonb changes. App code never writes to total_billable;
-- the trigger overwrites it.
--
-- Naming intent:
--   load_price        = the linehaul rate (UI label: "Linehaul")
--   total_billable    = linehaul + billable accessorials (UI label: "Total"
--                       — only shown when accessorials make it differ from
--                       load_price, otherwise hidden as noise)
--
-- Invoice snapshots remain immutable. invoices.snapshot.totalCharges is
-- still frozen at draft time. If accessorials change after a draft, the
-- live loads.total_billable will diverge from the snapshot until the
-- invoice is regenerated. That's correct behavior — the snapshot is the
-- broker's contract; the load row is the dispatcher's working copy.

-- ── 1. Column ──────────────────────────────────────────────────────────

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS total_billable double precision;

-- ── 2. Compute function ────────────────────────────────────────────────
--
-- Mirrors the buildSnapshot logic exactly:
--   • billable !== false  → in the loads jsonb this is COALESCE('billable', 'true') != 'false'
--                           (missing-billable is treated as billable, same as the API)
--   • amount > 0          → drops null / zero / negative accessorials
--   • sum(amount)         → accessorial subtotal
--
-- COALESCE(load_price, 0) handles null linehaul (rare; usually a TONU or
-- a draft load mid-entry). Resulting total_billable is 0 in that case,
-- matching what an invoice would render.

CREATE OR REPLACE FUNCTION loads_compute_total_billable(p_load_price double precision, p_accessorials jsonb)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_acc_total double precision;
BEGIN
  SELECT COALESCE(SUM((a->>'amount')::double precision), 0)
    INTO v_acc_total
    FROM jsonb_array_elements(COALESCE(p_accessorials, '[]'::jsonb)) AS a
   WHERE COALESCE(a->>'billable', 'true') <> 'false'
     AND COALESCE((a->>'amount')::double precision, 0) > 0;
  RETURN COALESCE(p_load_price, 0) + v_acc_total;
END;
$$;

-- ── 3. Trigger ─────────────────────────────────────────────────────────
--
-- BEFORE INSERT/UPDATE so the new value lands on the same row write,
-- avoiding a second UPDATE round-trip. Fires unconditionally; the cost
-- is one jsonb scan per load write, negligible at fleet scale (loads
-- accessorials arrays are typically <10 items).
--
-- We don't gate on "load_price or accessorials changed" because the
-- helper is IMMUTABLE and a no-op assignment when nothing relevant
-- changed. Simpler than tracking column-level dirty flags.

CREATE OR REPLACE FUNCTION trg_loads_recompute_total_billable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.total_billable := loads_compute_total_billable(NEW.load_price, NEW.accessorials);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS loads_recompute_total_billable ON loads;
CREATE TRIGGER loads_recompute_total_billable
  BEFORE INSERT OR UPDATE ON loads
  FOR EACH ROW EXECUTE FUNCTION trg_loads_recompute_total_billable();

-- ── 4. Backfill ────────────────────────────────────────────────────────
--
-- Compute total_billable for every existing row (including soft-deleted
-- ones — they still appear in historical reports and should have a
-- correct total). The explicit SET would be enough on its own, but the
-- BEFORE-trigger above also fires and re-computes the same value — both
-- land on the identical result, so the redundancy is harmless and the
-- statement stays readable.

UPDATE loads
   SET total_billable = loads_compute_total_billable(load_price, accessorials);

-- ── 5. Tell PostgREST about the new column ─────────────────────────────

NOTIFY pgrst, 'reload schema';
