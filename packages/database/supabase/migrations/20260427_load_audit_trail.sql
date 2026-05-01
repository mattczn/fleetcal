ALTER TABLE events ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS driver_history   jsonb;
