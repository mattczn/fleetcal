-- 20260707_ramp_transactions.sql
--
-- ramp_transactions — corporate card purchases ingested from Ramp's
-- Developer API (https://api.ramp.com/developer/v1). Curzon-only for
-- the initial rollout, gated at the API layer by the same env-var
-- pattern as Mudflap (RAMP_CLIENT_ID/RAMP_CLIENT_SECRET absent → sync
-- is a no-op, table stays empty on non-Curzon deploys).
--
-- Unlike fuel_transactions, Ramp txns span ALL spend categories
-- (fuel, parts, subscriptions, office supplies). Only a subset maps
-- to an asset; the rest live in the board as informational.
--
-- Memo→asset matching runs in the API after insert. Memos are
-- freeform prose ("Fuel for Miguel's truck", "Oil change 0809"),
-- so we record both the matched asset AND how we matched it
-- (asset_link_source) so dispatchers can spot low-confidence links.

CREATE TABLE IF NOT EXISTS ramp_transactions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   text NOT NULL,

  -- Provider identity ──────────────────────────────────────────────
  -- Open-coded so we can add Brex/Bill.com/etc. later without a
  -- migration. Validation lives in the API.
  provider                 text NOT NULL DEFAULT 'ramp',
  -- Ramp's transaction id (their `id` field). Required + unique per
  -- (org, provider) so re-polling the same window is a no-op.
  provider_transaction_id  text NOT NULL,

  -- Transaction facts ──────────────────────────────────────────────
  transacted_at            timestamptz NOT NULL,
  amount                   numeric(12, 2) NOT NULL,   -- positive = charge, negative = refund
  currency                 text NOT NULL DEFAULT 'USD',
  merchant_name            text,
  merchant_category_code   text,    -- MCC from card network
  sk_category_name         text,    -- Ramp's own category ("Fuel", "Auto Parts", "Software")
  memo                     text,
  -- Ramp returns an array of receipt objects; we keep the whole
  -- array as jsonb so the UI can render thumbnail + link without
  -- another API round-trip.
  receipts                 jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Cardholder ─────────────────────────────────────────────────────
  cardholder_ramp_user_id  text,
  cardholder_name          text,
  cardholder_email         text,
  card_id                  text,
  card_last4               text,

  -- Asset link (nullable — many txns won't map to equipment) ───────
  -- ON DELETE SET NULL: deleting an asset preserves the transaction
  -- history but clears the link.
  asset_id                 bigint REFERENCES assets(id) ON DELETE SET NULL,
  trailer_id               bigint REFERENCES trailers(id) ON DELETE SET NULL,
  -- 'memo_unit'         = memo contained an assets.unit / trailers.unit token
  -- 'memo_vin'          = memo contained a 17-char VIN match
  -- 'memo_plate'        = memo contained a normalized license plate
  -- 'driver_name'       = memo named a driver, resolved via driver_asset_prefs
  -- 'nickname'          = fuzzy match against assets.name
  -- 'manual'            = a human set it via PATCH /:id/match
  -- 'none'              = no asset link (not_applicable or unmatched)
  asset_link_source        text NOT NULL DEFAULT 'none'
                             CHECK (asset_link_source IN
                               ('memo_unit','memo_vin','memo_plate',
                                'driver_name','nickname','manual','none')),
  -- Enforce truck XOR trailer (never both at once).
  CONSTRAINT ramp_transactions_asset_xor_trailer
    CHECK (asset_id IS NULL OR trailer_id IS NULL),

  -- Match state ────────────────────────────────────────────────────
  -- 'unmatched'         = auto-matcher found nothing, needs review
  -- 'auto_matched'      = matcher linked it (see asset_link_source)
  -- 'manual_matched'    = a dispatcher set it via the UI
  -- 'not_applicable'    = category doesn't map to equipment
  --                       (office supplies, software, etc.) — matcher
  --                       skips these so they don't clutter "needs review"
  match_status             text NOT NULL DEFAULT 'unmatched'
                             CHECK (match_status IN
                               ('unmatched','auto_matched','manual_matched','not_applicable')),
  match_confidence         integer,    -- 0-100, NULL when unmatched/n/a
  match_notes              text,
  matched_at               timestamptz,
  matched_by               text,       -- clerk user id (NULL for auto-match)

  -- Audit ──────────────────────────────────────────────────────────
  raw_payload              jsonb,      -- full Ramp response row for backfills
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,

  CONSTRAINT ramp_transactions_provider_id_unique
    UNIQUE (org_id, provider, provider_transaction_id)
);

-- Main board query: recent transactions per org.
CREATE INDEX IF NOT EXISTS ramp_transactions_org_date_idx
  ON ramp_transactions (org_id, transacted_at DESC)
  WHERE deleted_at IS NULL;

-- Per-asset ledger drill-in.
CREATE INDEX IF NOT EXISTS ramp_transactions_asset_idx
  ON ramp_transactions (org_id, asset_id, transacted_at DESC)
  WHERE asset_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ramp_transactions_trailer_idx
  ON ramp_transactions (org_id, trailer_id, transacted_at DESC)
  WHERE trailer_id IS NOT NULL AND deleted_at IS NULL;

-- "Needs review" filter on the board.
CREATE INDEX IF NOT EXISTS ramp_transactions_unmatched_idx
  ON ramp_transactions (org_id, transacted_at DESC)
  WHERE match_status = 'unmatched' AND deleted_at IS NULL;

-- Per-cardholder filter.
CREATE INDEX IF NOT EXISTS ramp_transactions_cardholder_idx
  ON ramp_transactions (org_id, cardholder_ramp_user_id, transacted_at DESC)
  WHERE cardholder_ramp_user_id IS NOT NULL AND deleted_at IS NULL;

-- Standard updated_at trigger (function exists from earlier migrations).
CREATE TRIGGER ramp_transactions_updated_at
  BEFORE UPDATE ON ramp_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: same org-scoped pattern as every other core table (see
-- 20260611_rls_lockdown.sql). auth.jwt()->>'org_id' comes from the
-- Clerk session token.
ALTER TABLE public.ramp_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ramp_transactions_org_rw" ON public.ramp_transactions
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);
