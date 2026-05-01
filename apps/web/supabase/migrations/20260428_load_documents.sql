-- Documents uploaded by drivers from the mobile app: BOL, POD, scale tickets, etc.
-- Files live in the `load-documents` storage bucket, this table is the metadata index.

CREATE TABLE load_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  org_id                text NOT NULL,
  storage_path          text NOT NULL UNIQUE,
  file_name             text NOT NULL,
  mime_type             text,
  size_bytes            bigint,
  kind                  text NOT NULL DEFAULT 'other',     -- 'bol' | 'pod' | 'scale' | 'other'
  uploaded_at           timestamptz NOT NULL DEFAULT now(),
  uploaded_by_driver_id bigint REFERENCES drivers(id) ON DELETE SET NULL,
  notes                 text
);

CREATE INDEX idx_load_documents_event ON load_documents (event_id);
CREATE INDEX idx_load_documents_org   ON load_documents (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON load_documents TO authenticated;
