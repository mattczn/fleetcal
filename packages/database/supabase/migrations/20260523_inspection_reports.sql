-- 20260523_inspection_reports.sql
--
-- Driver vehicle inspection reports (DVIR). Drivers submit one or more
-- inspections per day — usually pre-trip, optionally additional ones
-- whenever they swap to a different truck or trailer.
--
-- Storage is silent-by-default: even at 1 inspection/day per truck
-- across a year you're under 5K rows per truck, fine for partial-
-- indexed queries. The has_defects column is denormalized so
-- "show only inspections that need attention" reads a tiny subset.

CREATE TABLE IF NOT EXISTS inspection_reports (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          text        NOT NULL,
  driver_id       bigint      NOT NULL REFERENCES drivers(id),

  -- Driver picks which equipment is being inspected at submit time.
  -- Both are optional independently — the form lets them pick truck,
  -- trailer, or both. CHECK constraint guarantees at least one is set.
  asset_id        bigint      REFERENCES assets(id),
  trailer_id      bigint      REFERENCES trailers(id),
  CONSTRAINT inspection_requires_equipment
    CHECK (asset_id IS NOT NULL OR trailer_id IS NOT NULL),

  -- The calendar date this inspection counts toward (driver's local
  -- date when they submitted). Stored as a date because the "did the
  -- driver inspect today" question is fundamentally a day question,
  -- not a precise timestamp.
  inspection_date date        NOT NULL,

  -- Item-by-item checklist results as jsonb so the form can evolve
  -- without migrations. Shape:
  --   [{ id: 'brakes_service', section: 'Brakes',
  --      label: 'Service brakes', status: 'pass'|'fail'|'na',
  --      notes?: string }, ...]
  -- Trailer items use the same shape; we keep them in a separate
  -- column so a future query like "trailer-only defects" is direct.
  items           jsonb       NOT NULL,
  trailer_items   jsonb,

  -- Free-form driver notes for the whole inspection (separate from
  -- per-item notes).
  notes           text,

  -- Denormalized for fast "any defect?" queries. Computed at write.
  has_defects     boolean     NOT NULL DEFAULT false,

  -- Driver's name at submit time, acts as the signature.
  signed_by       text        NOT NULL,

  submitted_at    timestamptz NOT NULL DEFAULT now()
);

-- Primary lookup: dispatch view of an asset's inspection history.
CREATE INDEX IF NOT EXISTS idx_inspections_asset_date
  ON inspection_reports (asset_id, inspection_date DESC);

-- Driver view of their own history + the "did I inspect today" check.
CREATE INDEX IF NOT EXISTS idx_inspections_driver_date
  ON inspection_reports (driver_id, inspection_date DESC);

-- Org-wide chronological list (admin / DOT export use).
CREATE INDEX IF NOT EXISTS idx_inspections_org_date
  ON inspection_reports (org_id, inspection_date DESC);

-- Partial index that powers the smart-history "defects only" view —
-- skipping rows where nothing's wrong keeps reads fast even as the
-- table grows.
CREATE INDEX IF NOT EXISTS idx_inspections_defects
  ON inspection_reports (asset_id, inspection_date DESC)
  WHERE has_defects = true;


-- Photos attached to specific checklist items (or the report as a
-- whole when item_id is null). Optional — drivers can submit without
-- photos; encouraged on any 'fail' item in the UI.
CREATE TABLE IF NOT EXISTS inspection_photos (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     uuid        NOT NULL REFERENCES inspection_reports(id) ON DELETE CASCADE,
  item_id       text,       -- which checklist item, when applicable
  storage_path  text        NOT NULL,
  caption       text,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inspection_photos_report
  ON inspection_photos (report_id);
