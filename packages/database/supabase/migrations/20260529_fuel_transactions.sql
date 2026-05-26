-- 20260529_fuel_transactions.sql
--
-- fuel_transactions — card-side fuel purchases ingested from the
-- carrier's fleet card provider (currently Mudflap). Paired with
-- fuel_reports (the driver-app-side submission of the same fuel-up)
-- via fuel_report_id. The match is computed by an auto-matcher in
-- the API and confirmed/overridden by dispatch via the manual link
-- UI.
--
-- Provenance: a Google Apps Script running under fuel@curzontrucking.com
-- polls Gmail every 30 minutes, finds unread Mudflap receipts, and
-- POSTs the raw MIME (plus PDF attachment as base64) to
--   POST /v1/fuel-transactions/inbound-email
-- The API parses the email, inserts a row here, and runs the auto-
-- matcher against existing fuel_reports.
--
-- Schema mirrors the old my-calendar fuel_transactions table (same
-- field names where they applied) so the existing dispatch UIs keep
-- their muscle memory. Net additions: org_id (multi-tenant), provider
-- (room to add EFS / WEX / Comdata later without column changes),
-- fuel_report_id (proper FK instead of bigint pointer to legacy
-- fuel_form_responses).
--
-- The `transaction_id` field on fuel_reports (added in
-- 2026-05-12-fuel-reports.sql) becomes a real FK here.

CREATE TABLE IF NOT EXISTS fuel_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Clerk org id (text, e.g. "org_2abc..."). Matches every other
  -- table in this DB.
  org_id          text NOT NULL,

  -- Provider identity ──────────────────────────────────────────────
  -- `provider` is open-coded text rather than an enum so we can add
  -- EFS / WEX / Comdata without a migration. Validation lives in
  -- the API.
  provider                 text NOT NULL DEFAULT 'mudflap',
  -- Provider's own transaction id (e.g. Mudflap's "T895913162369").
  -- Required + unique-per-(org, provider) so re-ingesting the same
  -- email is a no-op rather than a duplicate row.
  provider_transaction_id  text NOT NULL,

  -- Transaction details from the receipt ───────────────────────────
  -- Mudflap receipts include date but not time. We store date-only
  -- so we don't fabricate precision the source doesn't have.
  transaction_date         date NOT NULL,
  driver_name              text,    -- short name as shown on receipt ("Alonzo")
  location                 text,    -- "Maverik #695 - American Fork, UT"
  matched_truck            text,    -- unit number from receipt when present

  -- Diesel ─────────────────────────────────────────────────────────
  diesel_gallons           numeric(10, 3),
  diesel_retail_price      numeric(10, 4),    -- per-gallon retail
  diesel_discount_price    numeric(10, 4),    -- per-gallon after Mudflap discount
  diesel_total             numeric(10, 2),

  -- DEF ────────────────────────────────────────────────────────────
  def_gallons              numeric(10, 3),
  def_retail_price         numeric(10, 4),
  def_discount_price       numeric(10, 4),
  def_total                numeric(10, 2),

  -- Totals + payment ───────────────────────────────────────────────
  total_charged            numeric(10, 2) NOT NULL,
  total_saved              numeric(10, 2) NOT NULL DEFAULT 0,
  payment_last4            text,

  -- Match to driver-submitted fuel report ──────────────────────────
  -- NULL until the auto-matcher (or a dispatcher manually) links it.
  -- ON DELETE SET NULL — if a fuel_report is deleted (driver mis-
  -- submission cleanup), the transaction stays but the link clears.
  fuel_report_id           uuid REFERENCES fuel_reports(id) ON DELETE SET NULL,
  -- 'unmatched' | 'auto_matched' | 'manual_matched' | 'no_match_needed'
  -- (no_match_needed = dispatcher explicitly said "this won't have
  -- a driver form" — e.g. an apportioned fleet card swipe that
  -- isn't a normal driver fuel-up).
  match_status             text NOT NULL DEFAULT 'unmatched'
                             CHECK (match_status IN
                               ('unmatched','auto_matched','manual_matched','no_match_needed')),
  match_confidence         integer,    -- 0-100, NULL when unmatched
  match_notes              text,
  matched_at               timestamptz,
  matched_by               text,       -- clerk user id (NULL for auto-match)

  -- Legacy import marker ──────────────────────────────────────────
  -- Rows imported from the old my-calendar database carry the old
  -- form_response_id here for historical reference. NULL on rows
  -- that were ingested directly into FleetCal.
  legacy_form_response_id  bigint,

  -- Audit ─────────────────────────────────────────────────────────
  raw_email                text,    -- preserve raw MIME for debugging the parser
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,

  -- Idempotency: re-ingesting the same receipt is a no-op
  CONSTRAINT fuel_transactions_provider_id_unique
    UNIQUE (org_id, provider, provider_transaction_id)
);

-- Recent transactions per org (list view)
CREATE INDEX IF NOT EXISTS fuel_transactions_org_date_idx
  ON fuel_transactions (org_id, transaction_date DESC)
  WHERE deleted_at IS NULL;

-- Unmatched queue (the dashboard's "needs attention" tile). Partial
-- so it stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS fuel_transactions_unmatched_idx
  ON fuel_transactions (org_id, transaction_date DESC)
  WHERE match_status = 'unmatched' AND deleted_at IS NULL;

-- Back-pointer lookup ("show me the transaction for this report").
CREATE INDEX IF NOT EXISTS fuel_transactions_report_idx
  ON fuel_transactions (fuel_report_id)
  WHERE fuel_report_id IS NOT NULL;

-- Standard updated_at trigger (function exists from earlier migrations).
CREATE TRIGGER fuel_transactions_updated_at
  BEFORE UPDATE ON fuel_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Promote fuel_reports.transaction_id from "loose UUID pointer" to a
-- real FK. The 2026-05-12 migration left this as bare uuid because
-- fuel_transactions didn't exist yet. Now we wire it up.
-- ON DELETE SET NULL — if the card transaction gets deleted (rare,
-- maybe re-ingestion cleanup), the driver report stays but loses
-- its link. ON UPDATE CASCADE keeps the link valid if we ever
-- regenerate transaction ids (we won't, but the contract is cheap).
ALTER TABLE fuel_reports
  ADD CONSTRAINT fuel_reports_transaction_fk
  FOREIGN KEY (transaction_id) REFERENCES fuel_transactions(id)
  ON DELETE SET NULL;
