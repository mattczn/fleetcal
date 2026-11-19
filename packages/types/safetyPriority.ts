/**
 * Safety-alert priority — which Motive event types demand a dispatcher's
 * attention, and which are logged but not alerted on.
 *
 * There are three tiers, and they are NOT the same thing:
 *
 *   suppressed   — never shown anywhere. Lives in the API's
 *                  motivePerfFilter.ts (seat-belt, stop-sign, cam
 *                  obstruction). Ingested, never rendered.
 *   low priority — shown, but doesn't count as an alert: no badge, no
 *                  acknowledgement expected, sorted below everything
 *                  else. This file.
 *   priority     — the existing behaviour, unchanged: badge, ack queue,
 *                  top of the list.
 *
 * Why the split (2026-11-19): phone use alone was 2,272 of the 3,235
 * visible events in 30 days — 70% of the queue. A dispatcher who has to
 * clear 75 phone-use alerts a day stops reading the one tailgating alert
 * buried among them, which is the exact failure the bell exists to
 * prevent. Phone use still gets recorded, scored and coachable; it just
 * no longer interrupts.
 *
 * DEFAULT IS PRIORITY. Anything not listed below alerts. Motive adds
 * event types over time and a new one must not go silently unseen — the
 * cost of an unnecessary alert is noise, the cost of a missed one is a
 * crash nobody reviewed. Demote deliberately, by adding to the set.
 */

/** Event types that are logged and displayed, but never alert.
 *
 *  Matt's call, 2026-11-19: phone use and distraction by name; smoking
 *  and road-facing cam obstruction judged the same kind of thing (a
 *  policy or housekeeping nuisance, not a collision risk). Harsh
 *  driving — hard_brake / hard_corner — deliberately stays priority:
 *  it's how a near-miss usually shows up in the data. */
export const LOW_PRIORITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "cell_phone",
  "phone_use",
  "distraction",
  "smoking",
  "road_facing_cam_obstruction",
]);

export type SafetyPriority = "priority" | "low";

/** Priority tier for an event type. Unknown types are priority. */
export function safetyPriorityOf(eventType: string): SafetyPriority {
  return LOW_PRIORITY_EVENT_TYPES.has(eventType) ? "low" : "priority";
}

/** True when this event type should NOT raise a badge or wait for an ack. */
export function isLowPrioritySafetyEvent(eventType: string): boolean {
  return LOW_PRIORITY_EVENT_TYPES.has(eventType);
}

/** PostgREST `in` filter value — `(a,b,c)`. */
export function lowPriorityInFilter(): string {
  return `(${Array.from(LOW_PRIORITY_EVENT_TYPES).join(",")})`;
}
