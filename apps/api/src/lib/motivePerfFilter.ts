/**
 * Motive performance-event types that FleetCal suppresses everywhere
 * driver-facing or dispatch-facing.
 *
 * Motive fires a lot of low-signal events — a rolling stop at a
 * residential intersection, a seatbelt buckle 10 seconds late, a
 * camera the driver hasn't wiped this morning. Surfacing all of them
 * trained dispatch to ignore the whole alert bell, and the driver
 * app inbox filled with noise the driver couldn't act on. On
 * 2026-09-01 Matt asked to hide these three event types wholesale.
 *
 * INGESTED, NOT SHOWN. The Motive ingest still writes them to
 * motive_performance_events (small rows, cheap storage, kept in
 * case we ever want them for a compliance report or change our
 * mind). Every read surface — dispatch panel, dispatch bell badge,
 * driver-app safety inbox, driver safety score — filters them out
 * via the set below.
 *
 * If you're adding a new safety surface (a new API route, a new
 * KPI on the dashboard), import SUPPRESSED_EVENT_TYPES and apply
 * either as `.not("event_type", "in", ...)` in the DB query or as
 * `if (SUPPRESSED_EVENT_TYPES.has(row.event_type)) continue;` in
 * the aggregation loop. The list is short enough to inline as a
 * PostgREST `in` filter; the helper below formats it.
 */
export const SUPPRESSED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "seat_belt_violation",
  "stop_sign_violation",
  "camera_obstruction",
  "driver_facing_cam_obstruction",
]);

/** PostgREST `in` filter value — `(a,b,c)`. Pass to
 *  `.not("event_type", "in", suppressedInFilter())`. */
export function suppressedInFilter(): string {
  return `(${Array.from(SUPPRESSED_EVENT_TYPES).join(",")})`;
}
