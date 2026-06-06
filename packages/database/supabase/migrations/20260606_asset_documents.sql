-- 20260606_asset_documents.sql
--
-- Per-truck document attachments — registration, annual DOT
-- inspection, insurance card, title, etc. Mirrors the driver_documents
-- table shape so the API + UI patterns transfer cleanly.

CREATE TABLE IF NOT EXISTS asset_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text   NOT NULL,
  asset_id      bigint NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

  -- Document classification. 'other' is the escape hatch for anything
  -- that doesn't fit a named kind (IFTA permit, fuel card statement,
  -- bill of sale, etc.) — we'd rather have it on the truck than not.
  kind          text NOT NULL
                  CHECK (kind IN ('registration','inspection','insurance','title','other')),

  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  mime_type     text,
  size_bytes    integer,

  -- Optional context: registration and inspection both have annual
  -- expiration dates worth tracking next to the doc.
  expires_on    date,
  notes         text,

  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   text NOT NULL    -- clerk user id
);

CREATE INDEX IF NOT EXISTS asset_documents_asset_idx
  ON asset_documents (org_id, asset_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS asset_documents_kind_idx
  ON asset_documents (org_id, kind, uploaded_at DESC);

-- Storage bucket — private, signed-URL only.
INSERT INTO storage.buckets (id, name, public)
VALUES ('asset-documents', 'asset-documents', false)
ON CONFLICT (id) DO NOTHING;
