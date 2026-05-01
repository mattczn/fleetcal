-- Add timezone column to stops for per-stop timezone tracking
ALTER TABLE stops ADD COLUMN IF NOT EXISTS timezone text;
