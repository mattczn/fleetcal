/**
 * Shared bits for the load card/block convention used across the calendar
 * block, schedule card, search result, today's-loads row, and asset 24h
 * row. Consolidating here keeps colors/labels/time formats from drifting
 * between surfaces.
 */
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

/** "1 PM – 4 PM", or just "1 PM" when start === end. */
export function fmtTimeRange(load: Pick<Load, "start" | "end">): string {
  const s = fmtTime(load.start);
  const e = fmtTime(load.end ?? load.start);
  return e && e !== s ? `${s} – ${e}` : s;
}

/** "Mar 5, 2026" — used by surfaces that span multiple days (search). */
export function fmtCardDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Standard load-number label. Falls back to internal id, then em-dash. */
export function loadNumLabel(load: Pick<Load, "loadNum" | "internalLoadId">): string {
  return `Load #${load.loadNum ?? load.internalLoadId ?? "—"}`;
}
