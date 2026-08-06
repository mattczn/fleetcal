-- 20260806c_application_intake.sql
--
-- Website applications land in FleetCal, documents and all.
--
-- Two changes.
--
-- 1. The applicant row grows the fields the public form actually collects —
--    license number/state, DOB, work history — plus the signed authorization
--    that lets us pull an MVR. That authorization is the legal basis for
--    ordering the report, so it is stored as an audit record (who typed the
--    name, from what IP, when) rather than a bare boolean.
--
-- 2. `driver_documents` learns about applicants. The alternative was a
--    parallel `driver_application_documents` table, which would have meant a
--    second uploader, a second signed-URL path, and a copy step at hire time
--    that can half-fail. Instead a document may hang off an applicant OR a
--    driver, and hiring is an UPDATE that re-points the existing rows — the
--    CDL photo the applicant uploaded on the website becomes the CDL photo on
--    the driver profile, same object, same row, no copy.

-- ── Applicant intake fields ────────────────────────────────────────────────
ALTER TABLE driver_applications
  ADD COLUMN IF NOT EXISTS license_number     text,
  ADD COLUMN IF NOT EXISTS license_state      text,
  ADD COLUMN IF NOT EXISTS dob                date,
  ADD COLUMN IF NOT EXISTS experience         text,

  -- Signed MVR / background authorization, as submitted on the website form.
  ADD COLUMN IF NOT EXISTS consent_signature  text,
  ADD COLUMN IF NOT EXISTS consent_signed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS consent_ip         text,
  ADD COLUMN IF NOT EXISTS consent_user_agent text,
  -- Separate consents because they authorize different things: a consumer
  -- report/driving record vs. contacting previous employers under 391.23.
  ADD COLUMN IF NOT EXISTS consent_records    boolean,
  ADD COLUMN IF NOT EXISTS consent_employers  boolean,
  ADD COLUMN IF NOT EXISTS certified          boolean;

COMMENT ON COLUMN driver_applications.consent_signature IS
  'Typed legal name from the website authorization. With consent_ip/at, this is the record that permits ordering an MVR.';

-- ── Documents may belong to an applicant ───────────────────────────────────
ALTER TABLE driver_documents
  ADD COLUMN IF NOT EXISTS application_id uuid
    REFERENCES driver_applications(id) ON DELETE CASCADE;

-- driver_id was NOT NULL; an applicant has no driver row yet.
ALTER TABLE driver_documents
  ALTER COLUMN driver_id DROP NOT NULL;

-- Every document still has to belong to something. Both set is legal and
-- expected: that's a hired applicant's document, reachable from either side.
ALTER TABLE driver_documents
  DROP CONSTRAINT IF EXISTS driver_documents_owner_present;
ALTER TABLE driver_documents
  ADD CONSTRAINT driver_documents_owner_present
    CHECK (driver_id IS NOT NULL OR application_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS driver_documents_application_idx
  ON driver_documents (org_id, application_id, uploaded_at DESC);

COMMENT ON COLUMN driver_documents.driver_id IS
  'Null while the document belongs only to an applicant. Set at hire time, which is what moves the document onto the driver profile.';

-- Deliberately NOT extending the kind CHECK. CDL front and back are both
-- `license` — every surface that renders documents (web modal, driver app)
-- has a hardcoded label map over the four existing kinds, and a fifth would
-- render as a blank chip on a native app that ships on its own release
-- cycle. Front vs. back lives in `notes` and the file name.
