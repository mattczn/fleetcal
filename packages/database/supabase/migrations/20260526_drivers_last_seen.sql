-- 20260526_drivers_last_seen.sql
--
-- Track when each driver was last authenticated against the driver
-- app. Used by dispatch to confirm a driver successfully logged in
-- (e.g. after the onboarding test-OTP setup) and to spot drivers
-- whose token has gone stale.
--
-- Written by the /v1/driver/* auth middleware on every request, but
-- throttled in-process to one update per driver per ~2 minutes so an
-- active driver with React Query polling doesn't generate a write
-- storm.

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Index supports "who's been active today / this week" queries on
-- the dispatch sidebar's driver list.
CREATE INDEX IF NOT EXISTS idx_drivers_last_seen
  ON drivers (org_id, last_seen_at DESC NULLS LAST);

NOTIFY pgrst, 'reload schema';
