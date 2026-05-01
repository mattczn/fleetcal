CREATE TABLE IF NOT EXISTS org_settings (
  org_id          text PRIMARY KEY,
  show_driver_pay boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER org_settings_updated_at BEFORE UPDATE ON org_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
