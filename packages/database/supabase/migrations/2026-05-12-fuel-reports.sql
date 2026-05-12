-- ============================================================
-- fuel_reports — driver-submitted fuel purchase records
--
-- The authoritative "who fueled what asset, when, where, how much"
-- record. Drivers submit one row per fuel-up via the driver app;
-- everything is known at submit time (driver is the signed-in user,
-- asset is their assignment, state is auto-detected from GPS).
--
-- Phase 2 will introduce a `fuel_transactions` table fed by the fleet
-- card provider (Mudflap etc.). `transaction_id` + `match_status`
-- slots are present here so reports can be reconciled to transactions
-- without a follow-up migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS fuel_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,

  -- Who fueled (required — driver app always knows both). FK targets
  -- are bigint to match the existing drivers/assets PKs.
  driver_id       bigint NOT NULL REFERENCES drivers(id),
  asset_id        bigint NOT NULL REFERENCES assets(id),

  -- When + where. `reported_at` defaults to submit time but the driver
  -- can backdate via the form (forgot to log it earlier). `state` is a
  -- 2-letter US abbreviation — IFTA's unit of reporting.
  reported_at     timestamptz NOT NULL DEFAULT now(),
  state           text NOT NULL CHECK (length(state) = 2),
  latitude        double precision,
  longitude       double precision,

  -- Quantities
  diesel_gallons  numeric(10, 2) NOT NULL CHECK (diesel_gallons > 0),
  def_gallons     numeric(10, 2) CHECK (def_gallons IS NULL OR def_gallons >= 0),
  odometer        integer        CHECK (odometer IS NULL OR odometer >= 0),

  -- Phase 2 reconciliation. transaction_id is intentionally NOT a FK
  -- yet — fuel_transactions doesn't exist; we'll add the constraint in
  -- the Phase 2 migration. match_status is open-coded for the same
  -- reason (no enum yet).
  transaction_id  uuid,
  match_status    text NOT NULL DEFAULT 'pending'
                    CHECK (match_status IN ('pending','matched','no_transaction')),

  -- Audit
  submitted_by    text NOT NULL,    -- clerk user id OR driver supabase user id
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes shaped around the access patterns:
--   Recent reports per org (dashboard feed)
CREATE INDEX IF NOT EXISTS fuel_reports_org_reported_idx
  ON fuel_reports (org_id, reported_at DESC);

--   Per-asset history (asset detail page, MPG calc)
CREATE INDEX IF NOT EXISTS fuel_reports_asset_idx
  ON fuel_reports (org_id, asset_id, reported_at DESC);

--   Per-driver history (driver profile / driver-app "my submissions")
CREATE INDEX IF NOT EXISTS fuel_reports_driver_idx
  ON fuel_reports (org_id, driver_id, reported_at DESC);

--   Unmatched queue (Phase 2 dashboard's "needs attention" tile). Partial
--   index keeps it cheap as the table grows.
CREATE INDEX IF NOT EXISTS fuel_reports_pending_idx
  ON fuel_reports (org_id, reported_at DESC)
  WHERE match_status = 'pending';
