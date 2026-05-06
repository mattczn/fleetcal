/**
 * Shared bits for the driver-app load card convention. Mirrors
 * apps/dispatch/lib/loadCard.tsx — same status tints/labels, same time
 * formats, same Relay / NonRev chips — so a load looks consistent
 * whether the dispatcher or driver is reading it.
 */
import React from "react";
import { View, Text } from "react-native";
import Svg, { Defs, Pattern, Rect } from "react-native-svg";
import { Split } from "lucide-react-native";
import type { Load, LoadStatus, Stop } from "./types";

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

/** "Mar 5" — short date for stop labels. */
export function fmtShortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * "APPT" / "WINDOW" / "FCFS" — short schedule-type label drivers can
 * scan at a glance. Returns null when the field isn't set so callers
 * can fall back to the default formatting.
 */
export function fmtScheduleType(scheduleType?: Stop["scheduleType"]): string | null {
  if (!scheduleType) return null;
  if (scheduleType === "appointment") return "APPT";
  if (scheduleType === "window")      return "WINDOW";
  if (scheduleType === "fcfs")        return "FCFS";
  return null;
}

/**
 * Tiny pill that flags how a stop's time should be interpreted —
 * appointment (be there exactly), window (be there within), or
 * first-come-first-served (no fixed time). Drivers care a lot about
 * this distinction.
 */
export function ScheduleTypeChip({
  scheduleType, size = "default",
}: {
  scheduleType: Stop["scheduleType"];
  size?: "default" | "small";
}) {
  const label = fmtScheduleType(scheduleType);
  if (!label) return null;
  const fontSize = size === "small" ? 9 : 10;
  const padH     = size === "small" ? 5 : 6;
  const padV     = size === "small" ? 0 : 1;
  // appointment = strict (red-ish), window = flexible (blue),
  // fcfs = no appt (neutral gray)
  const tint =
    scheduleType === "appointment"
      ? { bg: "#fee2e2", fg: "#b91c1c" }
      : scheduleType === "window"
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
 * Pill-sized indicator for relay loads. `role` matches `Load.relayRole` —
 * "pickup" means this is the pickup leg of a relay (driver hands off),
 * "delivery" means the delivery leg (driver receives).
 */
export function RelayChip({
  role, size = "default",
}: {
  role: "pickup" | "delivery";
  size?: "default" | "small";
}) {
  const iconSize = size === "small" ? 9  : 10;
  const fontSize = size === "small" ? 9  : 10;
  const padH     = size === "small" ? 5  : 6;
  const padV     = size === "small" ? 0  : 1;
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 3,
      paddingHorizontal: padH, paddingVertical: padV,
      borderRadius: 999,
      backgroundColor: "#ede9fe",
    }}>
      <Split size={iconSize} color="#5b21b6" strokeWidth={2.4} />
      <Text style={[txt(800), { fontSize, color: "#5b21b6", letterSpacing: 0.3 }]}>
        RELAY · {role === "pickup" ? "PICKUP" : "DELIVERY"}
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
