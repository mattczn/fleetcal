-- ============================================================
-- Maintenance — Phase 1
--
-- Three tables + one storage bucket:
--
--   maintenance_reports        — driver-submitted issue reports.
--                                Immutable raw input. Asset XOR trailer.
--   maintenance_report_photos  — media attached to a report.
--   maintenance_action_items   — ops's tracked work. Created from a
--                                report (report_id set) OR ad-hoc.
--                                Status / priority / OOS / schedule
--                                are all set by ops, not the driver.
--
-- The split mirrors how closeout vs accounting works: the driver's
-- submission is the raw input; ops triages and acts on it.
-- ============================================================

-- ── maintenance_reports ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          text NOT NULL,

  driver_id       bigint NOT NULL REFERENCES drivers(id),

  -- Exactly one of asset_id / trailer_id (CHECK below). A single
  -- report is about a single piece of equipment — the driver picks
  -- truck OR trailer at submit time. If they have an issue with
  -- both, they file two reports.
  asset_id        bigint REFERENCES assets(id),
  trailer_id      bigint REFERENCES trailers(id),

  description     text NOT NULL,

  reported_at     timestamptz NOT NULL DEFAULT now(),
  latitude        double precision,
  longitude       double precision,
  state           text,

  -- Triage status — driver always submits as 'open'; ops drives
  -- transitions. `converted` means an action item was created from
  -- this report (action_item_id will be set).
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','reviewed','dismissed','converted')),
  action_item_id  uuid,

  submitted_by    text NOT NULL,           -- 'driver:{driverId}'
  created_at      timestamptz NOT NULL DEFAULT now(),

  CHECK ((asset_id IS NOT NULL)::int + (trailer_id IS NOT NULL)::int = 1)
);

CREATE INDEX IF NOT EXISTS maintenance_reports_org_idx
  ON maintenance_reports (org_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS maintenance_reports_open_idx
  ON maintenance_reports (org_id, reported_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS maintenance_reports_asset_idx
  ON maintenance_reports (org_id, asset_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS maintenance_reports_trailer_idx
  ON maintenance_reports (org_id, trailer_id, reported_at DESC);


-- ── maintenance_action_items ────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_action_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          text NOT NULL,

  asset_id        bigint REFERENCES assets(id),
  trailer_id      bigint REFERENCES trailers(id),

  title           text NOT NULL,
  description     text,
  category        text NOT NULL DEFAULT 'repair'
                    CHECK (category IN ('repair','pm','inspection','other')),
  priority        text NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('urgent','high','normal','low')),
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_progress','done')),
  out_of_service  boolean NOT NULL DEFAULT false,

  scheduled_date  date,
  due_date        date,

  report_id       uuid REFERENCES maintenance_reports(id),

  completed_at    timestamptz,
  completed_by    text,

  -- Phase-2 slots in place so we don't migrate twice when cost
  -- tracking lands.
  vendor          text,
  estimated_cost  numeric(10,2),
  actual_cost     numeric(10,2),

  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK ((asset_id IS NOT NULL)::int + (trailer_id IS NOT NULL)::int = 1)
);

CREATE INDEX IF NOT EXISTS maintenance_action_items_org_idx
  ON maintenance_action_items (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS maintenance_action_items_open_idx
  ON maintenance_action_items (org_id, created_at DESC)
  WHERE status IN ('open','in_progress');

CREATE INDEX IF NOT EXISTS maintenance_action_items_oos_idx
  ON maintenance_action_items (org_id)
  WHERE out_of_service = true AND status <> 'done';

CREATE INDEX IF NOT EXISTS maintenance_action_items_asset_idx
  ON maintenance_action_items (org_id, asset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS maintenance_action_items_trailer_idx
  ON maintenance_action_items (org_id, trailer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS maintenance_action_items_scheduled_idx
  ON maintenance_action_items (org_id, scheduled_date)
  WHERE scheduled_date IS NOT NULL AND status <> 'done';


-- ── maintenance_report_photos ───────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_report_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     uuid NOT NULL REFERENCES maintenance_reports(id) ON DELETE CASCADE,
  org_id        text NOT NULL,
  storage_path  text NOT NULL,
  file_name     text NOT NULL,
  mime_type     text,
  size_bytes    integer,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS maintenance_report_photos_report_idx
  ON maintenance_report_photos (report_id);


-- ── Storage bucket ──────────────────────────────────────────────
-- Private bucket; reads go through signed URLs minted server-side
-- (same pattern as load-documents). Public:false; the API uses the
-- service-role client to upload and to sign URLs on demand.
INSERT INTO storage.buckets (id, name, public)
VALUES ('maintenance-photos', 'maintenance-photos', false)
ON CONFLICT (id) DO NOTHING;
