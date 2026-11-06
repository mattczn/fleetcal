-- 20261105b_facility_contacts.sql
--
-- Multiple contacts per facility for the Shipper CRM. The facilities table
-- shipped with a single contact_name/phone/email; this adds a child table
-- so a warehouse can carry a whole roster (shipping manager, scheduler,
-- AP, etc.), each with first/last/title/email/phone.
--
-- The old single-contact columns on facilities are LEFT in place (unused by
-- the UI from here on) and their values are migrated into one contact row,
-- so nothing already typed is lost and nothing reading them breaks.

CREATE TABLE IF NOT EXISTS facility_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      text NOT NULL,
  facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  first_name  text,
  last_name   text,
  title       text,
  email       text,
  phone       text,
  created_by  text,                 -- clerk user id
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS facility_contacts_org_facility_idx
  ON facility_contacts (org_id, facility_id, created_at);

DROP TRIGGER IF EXISTS facility_contacts_updated_at ON facility_contacts;
CREATE TRIGGER facility_contacts_updated_at BEFORE UPDATE ON facility_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.facility_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "facility_contacts_org_rw" ON public.facility_contacts;
CREATE POLICY "facility_contacts_org_rw" ON public.facility_contacts
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ── Migrate the single contact already entered into the first row ──────
-- Splits contact_name on the first space into first/last. Idempotent: only
-- for facilities that have some contact data and no contact row yet.
INSERT INTO facility_contacts (org_id, facility_id, first_name, last_name, email, phone)
SELECT f.org_id, f.id,
       NULLIF(split_part(trim(f.contact_name), ' ', 1), ''),
       NULLIF(regexp_replace(trim(f.contact_name), '^\S+\s*', ''), ''),
       NULLIF(trim(f.contact_email), ''),
       NULLIF(trim(f.contact_phone), '')
FROM facilities f
WHERE (NULLIF(trim(f.contact_name),  '') IS NOT NULL
    OR NULLIF(trim(f.contact_email), '') IS NOT NULL
    OR NULLIF(trim(f.contact_phone), '') IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM facility_contacts c WHERE c.facility_id = f.id);
