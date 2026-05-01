-- Add short_name column to customers for abbreviated display in load titles
ALTER TABLE customers ADD COLUMN IF NOT EXISTS short_name text;
