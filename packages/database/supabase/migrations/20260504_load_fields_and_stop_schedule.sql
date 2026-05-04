-- Adds commodity + weight columns to loads, and schedule_type to stops.
-- Also widens stops.type to allow the new "drop" enum value (text column,
-- so no enum-type alteration needed — just app-side validation).

ALTER TABLE loads ADD COLUMN IF NOT EXISTS commodity text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS weight    integer; -- lbs

-- 'appointment' | 'window' | 'fcfs' — null means "use legacy interpretation
-- of apptStart/apptEnd (single time = appointment, both = window)".
ALTER TABLE stops ADD COLUMN IF NOT EXISTS schedule_type text;
