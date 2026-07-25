/**
 * Leg-position helpers for N-leg relay loads.
 *
 * A load's legs are its events ordered by leg_index (0-based). Role and
 * display label are DERIVED from position — never stored independently —
 * so inserting/removing a leg can't leave stale labels behind:
 *
 *   leg 0        → 'pickup'    → "Leg 1 · Pickup"
 *   last leg     → 'delivery'  → "Leg N · Delivery"
 *   anything else→ 'transfer'  → "Leg i · Transfer"
 *
 * A single-leg load has no relay labels at all (legLabel returns "").
 */

import type { RelayRole } from "./enums";
import type { Stop } from "./domain";

/**
 * Is this stop a relay leg boundary?
 *
 * Two kinds of handoff exist and both must count:
 *   - a dedicated `type:'relay'` stop (a bare trailer-drop point that
 *     isn't a pickup or delivery in its own right), and
 *   - any REAL stop flagged `isHandoff` (e.g. "leg 1 delivers in
 *     Hurricane and hands off there").
 *
 * Never test `stop.type === 'relay'` directly to find leg boundaries —
 * that misses the second kind.
 */
export function isHandoffStop(stop: Pick<Stop, "type" | "isHandoff">): boolean {
  return stop.type === "relay" || stop.isHandoff === true;
}

/**
 * Normalized handoff times: when the leg that ends here drops the
 * trailer, and when the leg that starts here takes it. Relay-point stops
 * store these in apptStart/apptEnd; handoffs on real stops use the
 * dedicated columns (their appt window belongs to the stop itself).
 */
export function handoffTimesOf(
  stop: Pick<Stop, "type" | "apptStart" | "apptEnd" | "handoffDropAt" | "handoffPickupAt">,
): { drop?: string; pickup?: string } {
  if (stop.type === "relay") {
    return { drop: stop.apptStart, pickup: stop.apptEnd };
  }
  return { drop: stop.handoffDropAt, pickup: stop.handoffPickupAt };
}

/** Indices of the handoff stops in an ordered stop list. Handoff i sits
 *  between leg i and leg i+1, so a list with H handoffs has H+1 legs. */
export function handoffIndexes(stops: Array<Pick<Stop, "type" | "isHandoff">>): number[] {
  const out: number[] = [];
  stops.forEach((s, i) => { if (isHandoffStop(s)) out.push(i); });
  return out;
}

/**
 * The slice of an ordered stop list belonging to leg `legIndex`.
 * Boundary handoff stops belong to BOTH adjacent legs — the leg that
 * ends there drives to it, the leg that starts there drives from it.
 */
export function stopsForLeg<T extends Pick<Stop, "type" | "isHandoff">>(
  stops: T[],
  legIndex: number,
): T[] {
  const marks = handoffIndexes(stops);
  if (marks.length === 0) return stops;
  const startIdx = legIndex <= 0 ? 0 : (marks[legIndex - 1] ?? 0);
  const endIdx = legIndex >= marks.length ? stops.length - 1 : marks[legIndex];
  return stops.slice(startIdx, endIdx + 1);
}

/** Derived relay_role for a leg position. undefined for single-leg loads. */
export function legRoleFor(
  legIndex: number,
  legCount: number,
): RelayRole | undefined {
  if (legCount <= 1) return undefined;
  if (legIndex <= 0) return "pickup";
  if (legIndex >= legCount - 1) return "delivery";
  return "transfer";
}

const ROLE_NAMES: Record<RelayRole, string> = {
  pickup: "Pickup",
  transfer: "Transfer",
  delivery: "Delivery",
};

/** "Pickup" | "Transfer" | "Delivery" for chips that only show the role. */
export function legRoleName(
  legIndex: number,
  legCount: number,
): string | undefined {
  const role = legRoleFor(legIndex, legCount);
  return role ? ROLE_NAMES[role] : undefined;
}

/** Full label: "Leg 1 · Pickup", "Leg 2 · Transfer", "Leg 3 · Delivery". */
export function legLabel(legIndex: number, legCount: number): string {
  const name = legRoleName(legIndex, legCount);
  return name ? `Leg ${legIndex + 1} · ${name}` : "";
}

/** Compact form for tight chips: "Leg 1/3". */
export function legShortLabel(legIndex: number, legCount: number): string {
  return legCount > 1 ? `Leg ${legIndex + 1}/${legCount}` : "";
}

/** Sort comparator for leg arrays: leg_index, then start as tiebreak. */
export function byLegIndex<
  T extends { legIndex?: number; start?: string },
>(a: T, b: T): number {
  const ai = a.legIndex ?? 0;
  const bi = b.legIndex ?? 0;
  if (ai !== bi) return ai - bi;
  return (a.start ?? "").localeCompare(b.start ?? "");
}
