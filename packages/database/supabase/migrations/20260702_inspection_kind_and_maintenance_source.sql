-- 20260702_inspection_kind_and_maintenance_source.sql
--
-- Curzon "Truck History" module — two supporting schema changes.
--
-- 1) Two daily inspections: pre-trip and post-trip. The existing single
--    daily DVIR functioned as a pre-trip, so we backfill existing rows to
--    'pre_trip'. `cleanliness_flagged` is denormalized from the new
--    cleanliness checklist item so the equipment-history views can filter
--    "left/received dirty" without cracking the items jsonb.
--
-- 2) Link a maintenance_report back to the failed inspection item it came
--    from. When a driver fails an item and files a report in step 3 of the
--    inspection flow, the report is tagged source='inspection' and points at
--    the originating inspection + item. This lets the known-damage view dedupe
--    and the web maintenance queue badge "from inspection".

-- ── inspection_reports: pre/post-trip + cleanliness flag ───────────────
ALTER TABLE inspection_reports
  ADD COLUMN IF NOT EXISTS kind                text    NOT NULL DEFAULT 'pre_trip',
  ADD COLUMN IF NOT EXISTS cleanliness_flagged boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_reports_kind_check') THEN
    ALTER TABLE inspection_reports
      ADD CONSTRAINT inspection_reports_kind_check CHECK (kind IN ('pre_trip','post_trip'));
  END IF;
END $$;

-- Asset history reads pull the most-recent inspection of each kind.
CREATE INDEX IF NOT EXISTS idx_inspections_asset_kind_date
  ON inspection_reports (asset_id, kind, inspection_date DESC);

-- ── maintenance_reports: origin link back to an inspection item ────────
ALTER TABLE maintenance_reports
  ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'driver',
  ADD COLUMN IF NOT EXISTS inspection_report_id uuid REFERENCES inspection_reports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS inspection_item_id   text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_reports_source_check') THEN
    ALTER TABLE maintenance_reports
      ADD CONSTRAINT maintenance_reports_source_check CHECK (source IN ('driver','inspection'));
  END IF;
END $$;

-- Fetch all reports spawned by a given inspection (step-3 loop, dedupe view).
CREATE INDEX IF NOT EXISTS idx_maintenance_reports_inspection
  ON maintenance_reports (inspection_report_id)
  WHERE inspection_report_id IS NOT NULL;
