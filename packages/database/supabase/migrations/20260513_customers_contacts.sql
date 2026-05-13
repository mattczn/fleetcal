-- Multi-contact support for customers. Previously each customer had a
-- single contact (contact_name / contact_email / contact_phone). In
-- practice brokers route different loads through different reps, so
-- dispatchers want a list they can grow over time.
--
-- Shape: jsonb array of { id, name?, email?, phone? }. Each contact has
-- a client-generated uuid for stable list keys and edit/delete ops.
--
-- The legacy single-contact columns stay in place; they're now treated
-- as a "primary" hint that's read-only after this migration. New writes
-- go to contacts[]. Backfill below migrates the existing single contact
-- into contacts[0] so no data is lost.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS contacts jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill: for every customer that has any of the legacy contact_*
-- fields populated AND contacts[] is still empty, build a single
-- contact entry from those fields. Idempotent — running again is a
-- no-op since contacts[] is now non-empty.
UPDATE customers
SET contacts = jsonb_build_array(
  jsonb_build_object(
    'id',    gen_random_uuid()::text,
    'name',  contact_name,
    'email', contact_email,
    'phone', contact_phone
  ) - 'id' || jsonb_build_object('id', gen_random_uuid()::text)
)
WHERE (contacts IS NULL OR contacts = '[]'::jsonb)
  AND (contact_name IS NOT NULL
       OR contact_email IS NOT NULL
       OR contact_phone IS NOT NULL);

-- Quick lookup for "find a customer by contact email" (e.g., when a
-- new broker emails us, surface the matching customer). Cheap GIN
-- index on the jsonb column.
CREATE INDEX IF NOT EXISTS idx_customers_contacts_gin
  ON customers USING gin (contacts);
