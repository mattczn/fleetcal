-- ============================================================
-- Dispatch Next — Supabase Schema
-- Run this in the SQL Editor of your new Supabase project.
--
-- ID strategy:
--   assets / drivers  → bigserial (integer) — matches app's number IDs
--   events            → uuid                — matches app's string IDs
-- ============================================================

-- ── Assets ────────────────────────────────────────────────
CREATE TABLE assets (
  id          bigserial PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#1a73e8',
  type        text NOT NULL DEFAULT 'Local',   -- OTR | Local | Dedicated | Regional
  unit        text,                             -- fleet/unit number
  truck       text,                             -- e.g. "2024 Freightliner 126"
  notes       text,
  hidden      boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Drivers ───────────────────────────────────────────────
CREATE TABLE drivers (
  id          bigserial PRIMARY KEY,
  org_id      text NOT NULL,
  name        text NOT NULL,
  first_name  text,
  last_name   text,
  phone       text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Default driver per asset ──────────────────────────────
CREATE TABLE driver_asset_prefs (
  asset_id    bigint NOT NULL REFERENCES assets(id)  ON DELETE CASCADE,
  driver_id   bigint NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  org_id      text NOT NULL,
  PRIMARY KEY (asset_id)
);

-- ── Driver-uploaded documents (BOL/POD/etc) ──────────────
CREATE TABLE load_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  org_id                text NOT NULL,
  storage_path          text NOT NULL UNIQUE,
  file_name             text NOT NULL,
  mime_type             text,
  size_bytes            bigint,
  kind                  text NOT NULL DEFAULT 'other',
  uploaded_at           timestamptz NOT NULL DEFAULT now(),
  uploaded_by_driver_id bigint REFERENCES drivers(id) ON DELETE SET NULL,
  notes                 text
);

-- ── Push notification tokens (driver mobile app) ─────────
CREATE TABLE driver_push_tokens (
  id           bigserial PRIMARY KEY,
  driver_id    bigint   NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  org_id       text     NOT NULL,
  token        text     NOT NULL UNIQUE,
  platform     text     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- ── Events (loads) ────────────────────────────────────────
CREATE TABLE events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               text NOT NULL,
  asset_id             bigint NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  title                text NOT NULL,
  start                text NOT NULL,          -- YYYY-MM-DDTHH:mm (naive Mountain Time)
  "end"                text NOT NULL,
  driver_name          text,
  driver_id            bigint REFERENCES drivers(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'scheduled',
  relay_group_id       uuid,
  relay_role           text,                   -- 'pickup' | 'delivery'

  -- Load Info
  load_num             text,
  ref_nums             text,
  bol_num              text,
  po_num               text,
  broker               text,
  commodity            text,
  weight               float8,
  miles                float8,
  team_load            boolean,
  hazmat               boolean,

  -- Locations
  pickup_city          text,
  delivery_city        text,
  pickup_appt          text,
  delivery_appt        text,

  -- Financial
  load_price           float8,
  driver_pay           float8,
  rate_per_mile        float8,
  fuel_surcharge       float8,
  factoring_company    text,
  invoice_num          text,
  payment_status       text,

  -- Equipment & People
  trailer_num          text,
  trailer_type         text,
  dispatcher           text,
  dispatched           boolean,

  -- Notes
  special_instructions text,
  notes                text,

  -- Attachment (base64 data URL — consider moving to Storage for large files)
  rate_con_pdf         text,

  -- Accessorials [{ id, category, description, amount, billable, status }]
  accessorials         jsonb,

  -- Audit trail
  created_by_name      text,
  audit_log            jsonb,

  -- Soft delete
  deleted_at           timestamptz,

  -- 12h-before-start confirmation push reminder (sent once)
  confirm_reminder_sent_at timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ── Stops (multi-stop routing) ───────────────────────────
CREATE TABLE stops (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  org_id         text NOT NULL,
  sequence       integer NOT NULL,
  type           text NOT NULL,          -- pickup | delivery | stop | drop_hook
  facility_name  text,
  address        text,
  city           text,                   -- locality from Google geocoder
  state          text,                   -- 2-letter administrative_area_level_1
  lat            double precision,
  lng            double precision,
  appt_start     text,                   -- YYYY-MM-DDTHH:mm or time string
  appt_end       text,                   -- null if no window
  geocode_status text NOT NULL DEFAULT 'pending',  -- pending | success | failed
  instructions   text,
  arrived_at     timestamptz,                      -- driver check-in time (mobile app)
  arrived_lat    numeric,
  arrived_lng    numeric,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER stops_updated_at BEFORE UPDATE ON stops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_stops_event ON stops(event_id);
CREATE INDEX idx_stops_org   ON stops(org_id);

-- ── Org-level Settings (driver app prefs, etc.) ───────────
CREATE TABLE org_settings (
  org_id          text PRIMARY KEY,
  show_driver_pay boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Auto-update updated_at ────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_settings_updated_at BEFORE UPDATE ON org_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Indexes ───────────────────────────────────────────────
CREATE INDEX idx_assets_org         ON assets(org_id);
CREATE INDEX idx_drivers_org        ON drivers(org_id);
CREATE INDEX idx_events_org         ON events(org_id);
CREATE INDEX idx_events_asset       ON events(asset_id);
CREATE INDEX idx_events_start       ON events(org_id, start);
CREATE INDEX idx_events_active      ON events(org_id, asset_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_events_relay       ON events(relay_group_id) WHERE relay_group_id IS NOT NULL;
CREATE INDEX idx_events_org_driver  ON events(org_id, driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX idx_events_pending_confirm_reminder ON events(start)
  WHERE status = 'scheduled' AND deleted_at IS NULL
    AND driver_id IS NOT NULL AND confirm_reminder_sent_at IS NULL;

-- ── Row Level Security ────────────────────────────────────
-- Enable after setting up Clerk JWT template in Supabase.
-- In Clerk Dashboard → JWT Templates → create "supabase" template with:
--   { "role": "authenticated", "org_id": "{{org.id}}" }
-- Then set SUPABASE_JWT_SECRET in Clerk to your Supabase JWT secret.

-- ALTER TABLE assets             ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE drivers            ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE driver_asset_prefs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE events             ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "org_isolation" ON assets
--   USING (org_id = (auth.jwt() ->> 'org_id'));
-- CREATE POLICY "org_isolation" ON drivers
--   USING (org_id = (auth.jwt() ->> 'org_id'));
-- CREATE POLICY "org_isolation" ON driver_asset_prefs
--   USING (org_id = (auth.jwt() ->> 'org_id'));
-- CREATE POLICY "org_isolation" ON events
--   USING (org_id = (auth.jwt() ->> 'org_id'));
