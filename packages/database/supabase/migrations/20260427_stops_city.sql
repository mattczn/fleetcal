-- Add city column to stops so the AI parser can populate the canonical city name
-- directly, instead of trying to parse it back out of the full address.
ALTER TABLE stops ADD COLUMN IF NOT EXISTS city text;
