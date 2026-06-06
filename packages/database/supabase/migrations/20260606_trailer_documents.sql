-- 20260606_trailer_documents.sql
--
-- Per-trailer document attachments — registration, annual DOT
-- inspection, insurance, title. Same shape as asset_documents /
-- driver_documents.

CREATE TABLE IF NOT EXISTS trailer_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text   NOT NULL,
  trailer_id    bigint NOT NULL REFERENCES trailers(id) ON DELETE CASCADE,

  kind          text NOT NULL
                  CHECK (kind IN ('registration','inspection','insurance','title','other')),

  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  mime_type     text,
  size_bytes    integer,

  expires_on    date,
  notes         text,

  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   text NOT NULL
);

CREATE INDEX IF NOT EXISTS trailer_documents_trailer_idx
  ON trailer_documents (org_id, trailer_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS trailer_documents_kind_idx
  ON trailer_documents (org_id, kind, uploaded_at DESC);

INSERT INTO storage.buckets (id, name, public)
VALUES ('trailer-documents', 'trailer-documents', false)
ON CONFLICT (id) DO NOTHING;
