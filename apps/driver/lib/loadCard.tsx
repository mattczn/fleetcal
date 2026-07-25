/**
 * Shared bits for the driver-app load card convention. Mirrors
 * apps/dispatch/lib/loadCard.tsx — same status tints/labels, same time
 * formats, same Relay / NonRev chips — so a load looks consistent
 * whether the dispatcher or driver is reading it.
 */
import React from "react";
import { View, Text } from "react-native";
import Svg, { Defs, Pattern, Rect } from "react-native-svg";
import type { Load, LoadStatus, Stop } from "./types";
import { handoffTimesOf } from "@fleetcal/types";
import { relayChipLabel } from "./relayLegs";

// Driver app uses inline txt() helpers across files — duplicate the
// shape here so this module doesn't depend on a shared font helper.
function txt(weight: 500 | 600 | 700 | 800) {
  return {
    fontFamily:
      weight === 500 ? "PlusJakartaSans_500Medium"  :
      weight === 600 ? "PlusJakartaSans_600SemiBold" :
      weight === 700 ? "PlusJakartaSans_700Bold"     :
                       "PlusJakartaSans_800ExtraBold",
  } as const;
}

export const STATUS_TINT: Record<LoadStatus, { bg: string; fg: string }> = {
  scheduled:  { bg: "#f1f3f4", fg: "#5f6368" },
  assigned:   { bg: "#ede9fe", fg: "#5b21b6" },
  dispatched: { bg: "#e8f0fe", fg: "#1558d6" },
  en_route:   { bg: "#fef3c7", fg: "#92400e" },
  picked_up:  { bg: "#f3e8fd", fg: "#6b21a8" },
  delivered:  { bg: "#e6f4ea", fg: "#15803d" },
  cancelled:  { bg: "#fce8e6", fg: "#b91c1c" },
  tonu:       { bg: "#fef3c7", fg: "#92400e" },
  problem:    { bg: "#fef0e6", fg: "#b85c00" },
};

export const STATUS_LABEL: Record<LoadStatus, string> = {
  scheduled:  "Scheduled",
  assigned:   "Assigned",
  dispatched: "Dispatched",
  en_route:   "En Route",
  picked_up:  "Picked Up",
  delivered:  "Delivered",
  cancelled:  "Cancelled",
  tonu:       "TONU",
  problem:    "Problem",
};

/** "Scheduled" is the default — surfaces hide the pill on that state. */
export function showStatusPill(s: LoadStatus): boolean {
  return s !== "scheduled";
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** "1 PM" / "1:30 PM" from naive "YYYY-MM-DDTHH:mm". */
export function fmtTime(iso?: string): string {
  if (!iso) return "";
  const t = iso.slice(11, 16);
  if (!t) return "";
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (Number.isNaN(h)) return "";
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return m === 0 ? `${hh} ${ampm}` : `${hh}:${pad2(m)} ${ampm}`;
}

/** "8a" / "12:30p" — compact form for tight spaces. */
export function fmtTimeShort(iso?: string): string {
  if (!iso) return "";
  const t = iso.slice(11, 16);
  if (!t) return "";
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (Number.isNaN(h)) return "";
  const tag = h >= 12 ? "p" : "a";
  const hh = h % 12 || 12;
  return m === 0 ? `${hh}${tag}` : `${hh}:${pad2(m)}${tag}`;
}

export function fmtTimeRange(load: Pick<Load, "start" | "end">): string {
  const s = fmtTime(load.start);
  const e = fmtTime(load.end ?? load.start);
  return e && e !== s ? `${s} – ${e}` : s;
}

export function fmtTimeRangeShort(load: Pick<Load, "start" | "end">): string {
  const s = fmtTimeShort(load.start);
  const e = fmtTimeShort(load.end ?? load.start);
  return e && e !== s ? `${s}-${e}` : s;
}

/** Stop appt window — "8a-12p" or "8 AM" depending on scheduleType. */
export function fmtStopAppt(stop?: Stop): string {
  if (!stop?.apptStart) return "";
  const start = fmtTimeShort(stop.apptStart);
  if (!stop.apptEnd || stop.apptEnd === stop.apptStart) return start;
  const end = fmtTimeShort(stop.apptEnd);
  return `${start}-${end}`;
}

/**
 * Time on a handoff stop relative to THIS driver's leg.
 *
 * A handoff carries two times — the earlier leg's drop and the later
 * leg's pickup. Where they live depends on the kind of handoff:
 *   - relay-point stop → apptStart / apptEnd (the row has no appointment
 *     of its own, so it reuses those columns)
 *   - handoff on a REAL stop → handoffDropAt / handoffPickupAt (its
 *     apptStart/apptEnd belong to the stop's own appointment)
 * `handoffTimesOf()` normalizes both shapes.
 *
 * On a load card, showing both as a range ("9a-10a") is confusing — the
 * driver only cares about THEIR own time. Direction is relative to MY
 * leg (see lib/relayLegs.ts):
 *
 *   'outbound' (boundary legIndex — I drop here)      → drop time
 *   'inbound'  (boundary legIndex-1 — I pick up here) → pickup time
 */
export function fmtRelayHandoffTime(
  stop: Stop | undefined,
  direction: "inbound" | "outbound",
): string {
  if (!stop) return "";
  const { drop, pickup } = handoffTimesOf(stop);
  const iso = direction === "outbound" ? drop : (pickup ?? drop);
  if (!iso) return "";
  return fmtTimeShort(iso);
}

/**
 * Sub-label for a relay handoff stop — "Drop" when it's MY outbound
 * handoff (I leave the trailer there) and "Pickup" when it's MY inbound
 * handoff (I collect it). Pairs with the existing "RELAY HANDOFF" label
 * to form e.g. "RELAY HANDOFF · DROP · 9a". A middle (transfer) leg has
 * one of each.
 */
export function relayHandoffAction(direction: "inbound" | "outbound"): "Drop" | "Pickup" {
  return direction === "outbound" ? "Drop" : "Pickup";
}

/** "Mar 5" — short date for stop labels. */
export function fmtShortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Infer the schedule type from the appointment fields when the explicit
 * column is null — older stops in the database don't have schedule_type
 * populated, but they still have apptStart/apptEnd and the type is
 * usually obvious from those:
 *
 *   - both apptStart and apptEnd, with end > start  → "window"
 *   - apptStart only (or end == start)              → "appointment"
 *   - neither                                       → "fcfs"
 *
 * Returns the explicit field unchanged when set.
 */
export function inferScheduleType(stop?: Pick<Stop, "scheduleType" | "apptStart" | "apptEnd">): Stop["scheduleType"] {
  if (!stop) return undefined;
  if (stop.scheduleType) return stop.scheduleType;
  if (stop.apptStart && stop.apptEnd && stop.apptEnd !== stop.apptStart) return "window";
  if (stop.apptStart) return "appointment";
  return "fcfs";
}

/**
 * "APPT" / "WINDOW" / "FCFS" — short schedule-type label drivers can
 * scan at a glance. Accepts either the raw scheduleType value or a stop
 * to infer from. Returns null when nothing meaningful is available.
 */
export function fmtScheduleType(
  arg?: Stop["scheduleType"] | Pick<Stop, "scheduleType" | "apptStart" | "apptEnd">,
): string | null {
  const t = typeof arg === "object" && arg !== null
    ? inferScheduleType(arg)
    : (arg as Stop["scheduleType"]);
  if (!t) return null;
  if (t === "appointment") return "APPT";
  if (t === "window")      return "WINDOW";
  if (t === "fcfs")        return "FCFS";
  return null;
}

/**
 * Tiny pill that flags how a stop's time should be interpreted —
 * appointment (be there exactly), window (be there within), or
 * first-come-first-served (no fixed time). Drivers care a lot about
 * this distinction.
 */
export function ScheduleTypeChip({
  stop, size = "default",
}: {
  /** Pass the whole stop so the helper can infer when scheduleType is null. */
  stop:  Pick<Stop, "scheduleType" | "apptStart" | "apptEnd">;
  size?: "default" | "small";
}) {
  const inferred = inferScheduleType(stop);
  const label    = fmtScheduleType(inferred);
  if (!label) return null;
  const fontSize = size === "small" ? 9 : 10;
  const padH     = size === "small" ? 5 : 6;
  const padV     = size === "small" ? 0 : 1;
  // appointment = strict (red-ish), window = flexible (blue),
  // fcfs = no appt (neutral gray)
  const tint =
    inferred === "appointment"
      ? { bg: "#fee2e2", fg: "#b91c1c" }
      : inferred === "window"
      ? { bg: "#e8f0fe", fg: "#1558d6" }
      : { bg: "#f1f3f4", fg: "#5f6368" };
  return (
    <View style={{
      paddingHorizontal: padH, paddingVertical: padV,
      borderRadius: 999,
      backgroundColor: tint.bg,
    }}>
      <Text style={[txt(800), { fontSize, color: tint.fg, letterSpacing: 0.4 }]}>
        {label}
      </Text>
    </View>
  );
}

/** Standard load-number label, "#45280". Falls back to internal id. */
export function loadNumLabel(load: Pick<Load, "loadNum" | "internalLoadId">): string {
  return `#${load.loadNum ?? load.internalLoadId ?? "—"}`;
}

/**
 * Sparse diagonal-stripe overlay that marks non-revenue events.
 * Same defaults as dispatch's so the visual reads identically across
 * apps. Drop as the first child of an `overflow: hidden` card.
 */
export function DiagonalStripes({
  color = "rgba(95,99,104,0.08)",
  spacing = 22,
  thickness = 2,
}: {
  color?:     string;
  spacing?:   number;
  thickness?: number;
}) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern
            id="non-rev-stripes"
            width={spacing}
            height={spacing}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-45)"
          >
            <Rect width={thickness} height={spacing} fill={color} />
          </Pattern>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#non-rev-stripes)" />
      </Svg>
    </View>
  );
}

/** Compact "NON-REV" pill for the title row. */
export function NonRevChip({ size = "default" }: { size?: "default" | "small" }) {
  const fontSize = size === "small" ? 9 : 10;
  const padH     = size === "small" ? 5 : 6;
  const padV     = size === "small" ? 0 : 1;
  return (
    <View style={{
      paddingHorizontal: padH, paddingVertical: padV,
      borderRadius: 999,
      backgroundColor: "#fef3c7",
    }}>
      <Text style={[txt(800), { fontSize, color: "#92400e", letterSpacing: 0.4 }]}>
        NON-REV
      </Text>
    </View>
  );
}

/**
 * Pill-sized indicator for relay legs — "LEG 1/2 · PICKUP",
 * "LEG 2/3 · TRANSFER", etc. Position-based (leg i of N), so it works
 * for any leg count; role text is derived from position via
 * @fleetcal/types legRoleName. Pass the LegPosition from
 * lib/relayLegs.ts `legPositionOf(load)`.
 */
export function RelayChip({
  legIndex,
  legCount,
  // `size` is kept for backwards-compatibility with existing callers
  // but no longer changes the rendering — the chip matches the
  // Schedule screen's leg pill 1:1 so the same load reads
  // consistently across Loads + Schedule.
}: {
  legIndex: number;
  legCount: number;
  size?: "default" | "small";
}) {
  const label = relayChipLabel({ legIndex, legCount });
  if (!label) return null;
  return (
    <View style={{
      height: 20, paddingHorizontal: 8, borderRadius: 7,
      backgroundColor: "#ede9fe",
      justifyContent: "center",
    }}>
      <Text style={[txt(800), { fontSize: 10, letterSpacing: 0.4, color: "#5b21b6" }]}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Status pill — only renders when status diverges from "scheduled" (the
 * default state, which adds no information). Same colors as dispatch.
 */
export function StatusPill({
  status, size = "default",
}: {
  status: LoadStatus;
  size?:  "default" | "small";
}) {
  if (!showStatusPill(status)) return null;
  const tint = STATUS_TINT[status];
  const fontSize = size === "small" ? 9 : 10;
  const padH     = size === "small" ? 7 : 8;
  const padV     = size === "small" ? 1 : 2;
  return (
    <View style={{
      paddingHorizontal: padH, paddingVertical: padV,
      borderRadius: 999,
      backgroundColor: tint.bg,
    }}>
      <Text style={[txt(800), { fontSize, color: tint.fg, letterSpacing: 0.3 }]}>
        {STATUS_LABEL[status].toUpperCase()}
      </Text>
    </View>
  );
}
