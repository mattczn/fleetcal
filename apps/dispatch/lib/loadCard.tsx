/**
 * Shared bits for the load card/block convention used across the calendar
 * block, schedule card, search result, today's-loads row, and asset 24h
 * row. Consolidating here keeps colors/labels/time formats from drifting
 * between surfaces.
 */
import React from "react";
import { View, Text } from "react-native";
import Svg, { Defs, Pattern, Rect } from "react-native-svg";
import { Split } from "lucide-react-native";
import { txt } from "@/lib/font";
import type { Load, LoadStatus } from "./types";

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

/** Compact form for tight spaces — "8a", "12:30p". */
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

/** "1 PM – 4 PM", or just "1 PM" when start === end. */
export function fmtTimeRange(load: Pick<Load, "start" | "end">): string {
  const s = fmtTime(load.start);
  const e = fmtTime(load.end ?? load.start);
  return e && e !== s ? `${s} – ${e}` : s;
}

/** Compact form for tight spaces — "8a-12p". */
export function fmtTimeRangeShort(load: Pick<Load, "start" | "end">): string {
  const s = fmtTimeShort(load.start);
  const e = fmtTimeShort(load.end ?? load.start);
  return e && e !== s ? `${s}-${e}` : s;
}

/** "Mar 5, 2026" — used by surfaces that span multiple days (search). */
export function fmtCardDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Standard load-number label, "#45280". Falls back to internal id, then em-dash. */
export function loadNumLabel(load: Pick<Load, "loadNum" | "internalLoadId">): string {
  return `#${load.loadNum ?? load.internalLoadId ?? "—"}`;
}

/** Money: "$1,200" — empty string when unset, no cents on whole dollars. */
export function fmtPrice(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "";
  const whole = Math.round(n) === n;
  return whole
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Diagonal-stripe overlay used to mark non-revenue events visually
 * (Maintenance, Deadhead, etc.) wherever they show up alongside revenue
 * loads. Drop this as the first child of an `overflow: hidden` card and
 * it'll fill the parent at low contrast, with text/content layered above.
 *
 * Implemented via an SVG `<Pattern>` so the stripes scale with the card
 * and don't pixelate on retina; pointer events are disabled so taps fall
 * through to the underlying card.
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

/** Compact "NON-REV" pill for use in the same row as the title. */
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
 * "pickup" means this is the pickup leg of a relay, "delivery" means the
 * delivery leg.
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
