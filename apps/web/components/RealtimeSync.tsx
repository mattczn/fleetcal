'use client';

/**
 * Currently disabled.
 *
 * The previous implementation subscribed to `postgres_changes` on the
 * events table and applied each row via the legacy `dbEventToApp`
 * converter, which reads load-level fields from the now-deprecated
 * event columns. After the loads/events split (Phase 2.5a) and the
 * Railway wire-up (Phase 3 web part 2), Railway-created events have
 * sparse legacy columns — applying the realtime payload would clobber
 * the joined load data in state with undefined. Worse, the INSERT
 * handler raced with addEvent's optimistic-insert + Railway-response
 * swap and produced duplicate state entries with the same id.
 *
 * Re-enable once realtime payloads either:
 *   (a) trigger a fresh joined fetch instead of converting payload directly, or
 *   (b) merge only event-level fields, leaving load-level fields untouched.
 *
 * Single-user dev doesn't need cross-tab/multi-user sync; this is safe
 * to leave off in the meantime.
 */
export default function RealtimeSync() {
  return null;
}
