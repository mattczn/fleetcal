-- 20260716b_motive_perf_events_dispute.sql
--
-- Driver-initiated dispute workflow for Motive safety events.
--
-- Flow:
--   1. Dispatcher notifies driver about a safety event (existing flow).
--   2. Driver opens the alert in-app, taps "Dispute" and writes a
--      short reason.
--      → dispute_status = 'pending', disputed_at, dispute_reason set.
--   3. Dispatcher opens the safety panel, sees the disputed alert
--      surfaced, reads the reason.
--   4. Dispatcher accepts (event was wrong) or rejects (event stands).
--      → dispute_status = 'accepted' | 'rejected', dispute_reviewed_at,
--        dispute_reviewer_id, dispute_resolution set.
--
-- Accepted disputes are excluded from the driver's safety score — a
-- misattributed event shouldn't hurt the number. Rejected disputes
-- still count but preserve the driver's reason for record.
--
-- CHECK constraint on dispute_status keeps the state machine clean.
-- No default value on disputed_at / reviewer / resolution — those stay
-- NULL until the relevant step happens.

ALTER TABLE motive_performance_events
  ADD COLUMN IF NOT EXISTS dispute_status        text
    CHECK (dispute_status IN ('none','pending','accepted','rejected'))
    DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS disputed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_reason        text,
  ADD COLUMN IF NOT EXISTS dispute_reviewed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_reviewer_id   text,
  ADD COLUMN IF NOT EXISTS dispute_resolution    text;

-- Partial index for the dispatch "disputes needing review" filter.
-- Almost every row has dispute_status='none' — a partial index keeps it
-- tiny while giving fast lookups when the dispatcher filters to pending.
CREATE INDEX IF NOT EXISTS idx_motive_performance_events_dispute_pending
  ON motive_performance_events (org_id, disputed_at DESC)
  WHERE dispute_status = 'pending';

-- Backfill: nothing to do — existing rows default to 'none' via the
-- ADD COLUMN … DEFAULT clause above.
