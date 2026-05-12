-- ============================================================
-- fuel_report_photos + fuel-receipts storage bucket
--
-- Drivers attach a receipt photo (or several) when submitting a
-- fuel-up. Same shape + lifecycle as maintenance_report_photos:
-- private bucket, signed URLs minted server-side, ON DELETE CASCADE
-- so removing a report tears down its photos too.
-- ============================================================

CREATE TABLE IF NOT EXISTS fuel_report_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     uuid NOT NULL REFERENCES fuel_reports(id) ON DELETE CASCADE,
  org_id        text NOT NULL,
  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  mime_type     text,
  size_bytes    integer,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fuel_report_photos_report_idx
  ON fuel_report_photos (report_id);

INSERT INTO storage.buckets (id, name, public)
VALUES ('fuel-receipts', 'fuel-receipts', false)
ON CONFLICT (id) DO NOTHING;
