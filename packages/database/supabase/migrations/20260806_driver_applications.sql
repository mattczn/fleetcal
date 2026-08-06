-- 20260806_driver_applications.sql
--
-- Applicant pipeline for the `hiring` module.
--
-- Applicants are deliberately NOT rows in `drivers`. A driver row feeds
-- dispatch — assignment dropdowns, the calendar, payroll — and someone you
-- are still screening has no business appearing there. `driver_id` stays null
-- until they're hired, at which point the conversion creates the driver and
-- links the two.

CREATE TABLE IF NOT EXISTS driver_applications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     text NOT NULL,

  first_name text NOT NULL,
  last_name  text NOT NULL,
  phone      text,
  email      text,
  -- Needed for the contractor agreement. Collected here when known, and the
  -- driver can fill it in themselves at signing when it isn't.
  address    text,

  cdl_class  text,
  position   text,
  -- Becomes the agreement's Effective Date when they're hired.
  start_date date,

  status     text NOT NULL DEFAULT 'new'
               CHECK (status IN ('new','screening','offered','hired','rejected')),

  -- Where the application came from: 'website' for the public form, 'manual'
  -- for someone dispatch typed in.
  source     text NOT NULL DEFAULT 'manual',
  notes      text,

  -- Set on conversion. The link is what makes "already hired" unambiguous.
  driver_id  bigint REFERENCES drivers(id) ON DELETE SET NULL,
  hired_at   timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS driver_applications_org_idx
  ON driver_applications (org_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS driver_applications_driver_idx
  ON driver_applications (org_id, driver_id);

CREATE TRIGGER driver_applications_updated_at
  BEFORE UPDATE ON driver_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
