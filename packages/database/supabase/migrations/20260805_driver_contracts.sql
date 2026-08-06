-- 20260805_driver_contracts.sql
--
-- Independent Contractor Agreements signed through the portal.
--
-- The merge values are SNAPSHOTTED onto this row at issue rather than joined
-- from `drivers` at read time. A contract is a record of what someone agreed
-- to on a date; if a driver later moves house, the signed agreement must keep
-- the address it was signed with. Same reason template_version is stored — a
-- later revision of the agreement must not retroactively change what a driver
-- already signed.

CREATE TABLE IF NOT EXISTS driver_contracts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text   NOT NULL,
  driver_id     bigint NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,

  template_key     text    NOT NULL DEFAULT 'ica',
  template_version integer NOT NULL,

  -- Unguessable link the driver receives. No login: they get the URL by text
  -- or email and sign on their phone.
  public_token  uuid NOT NULL DEFAULT gen_random_uuid(),

  -- Snapshot at issue. effective_date comes from drivers.active_from — the
  -- hire date — so the agreement dates itself to when they started.
  effective_date     date NOT NULL,
  contractor_name    text NOT NULL,
  contractor_address text,

  status        text NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('sent','signed','voided')),

  sent_at       timestamptz NOT NULL DEFAULT now(),

  -- Signature + the audit trail that makes it hold up: who typed what, when,
  -- and from where. ESIGN/UETA want intent, consent, and attribution.
  signed_name       text,
  signed_at         timestamptz,
  signed_ip         text,
  signed_user_agent text,
  consented         boolean NOT NULL DEFAULT false,

  -- Storage path of the generated PDF in the driver-documents bucket.
  document_path text,

  voided_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_contracts_public_token_key
  ON driver_contracts (public_token);

CREATE INDEX IF NOT EXISTS driver_contracts_driver_idx
  ON driver_contracts (org_id, driver_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS driver_contracts_status_idx
  ON driver_contracts (org_id, status, sent_at DESC);

CREATE TRIGGER driver_contracts_updated_at
  BEFORE UPDATE ON driver_contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN driver_contracts.public_token IS
  'Opaque signing-link token. Never expose alongside org_id or pay data.';
COMMENT ON COLUMN driver_contracts.effective_date IS
  'Snapshot of drivers.active_from at issue — the agreement''s Effective Date.';
