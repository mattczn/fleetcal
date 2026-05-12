-- ============================================================
-- loads.is_tonu
--
-- TONU = Truck Order Not Used. Carrier got dispatched and showed
-- up but the broker cancelled the move; the carrier still bills a
-- TONU fee (typically a flat rate) but no actual delivery happens,
-- so no POD ever exists for the load.
--
-- This flag exempts the load from the closeout auto-flag's
-- "missing POD on delivered load" check. Other impediments
-- (pending accessorials, manual flag) still apply.
-- ============================================================

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS is_tonu boolean NOT NULL DEFAULT false;
