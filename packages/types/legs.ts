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
