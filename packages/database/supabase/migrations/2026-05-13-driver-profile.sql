-- ============================================================
-- Driver profile fields + driver_documents
--
-- The driver app's Profile tab + the dispatch DriversModal both
-- need fuller HR-style fields: email, address, license info,
-- medical card, DOB. Plus a documents table for uploaded scans
-- (license, medical card, MVR, other) with a dedicated private
-- storage bucket.
-- ============================================================

-- New columns on the existing drivers row. All nullable — drivers
-- and ops fill them in over time.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS email             text,
  ADD COLUMN IF NOT EXISTS address           text,
  ADD COLUMN IF NOT EXISTS license_number    text,
  ADD COLUMN IF NOT EXISTS license_state     text,
  ADD COLUMN IF NOT EXISTS license_exp       date,
  ADD COLUMN IF NOT EXISTS medical_card_exp  date,
  ADD COLUMN IF NOT EXISTS dob               date;

-- ── driver_documents ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text   NOT NULL,
  driver_id     bigint NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,

  kind          text NOT NULL
                  CHECK (kind IN ('license','medical_card','mvr','other')),

  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  mime_type     text,
  size_bytes    integer,

  -- Optional context: for license + medical_card the document's
  -- expiration date matters; we copy it here so the documents
  -- list can show expiry without joining back to the drivers row.
  -- (For non-dated kinds these stay null.)
  expires_on    date,
  notes         text,

  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   text NOT NULL    -- 'driver:{id}' or clerk user id
);

CREATE INDEX IF NOT EXISTS driver_documents_driver_idx
  ON driver_documents (org_id, driver_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS driver_documents_kind_idx
  ON driver_documents (org_id, kind, uploaded_at DESC);

-- ── Storage bucket ──────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('driver-documents', 'driver-documents', false)
ON CONFLICT (id) DO NOTHING;
