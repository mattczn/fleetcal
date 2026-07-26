/**
 * Shared visual primitives for the maintenance tab — status pills,
 * priority chips, formatters. Mirrors the color taxonomy from the web's
 * equipment page (apps/web/app/equipment/page.tsx) so dispatchers can
 * flip between the two surfaces without re-learning the palette.
 */
import React from "react";
import { View, Text } from "react-native";
import type {
  MaintenanceActionStatus,
  MaintenancePriority,
  MaintenanceReportStatus,
} from "@fleetcal/types";
import { txt } from "./font";

// ── Color tokens ──────────────────────────────────────────────────────

/** Background / foreground colors for each work-order status pill. */
export const STATUS_COLORS: Record<MaintenanceActionStatus, { bg: string; fg: string; label: string }> = {
  open:        { bg: "#eef1f3", fg: "#5f6368", label: "Open" },
  in_progress: { bg: "#fef7e0", fg: "#b06000", label: "In progress" },
  done:        { bg: "#e6f4ea", fg: "#1e8e3e", label: "Done" },
};

/** Legacy 'reviewed' is the same state as 'dismissed' — this app used
 *  to write it for the action the web calls "Ignore". It shares the
 *  dismissed swatch and label verbatim so a dispatcher can't tell an
 *  old row from a new one. See MaintenanceReportStatus in
 *  @fleetcal/types. */
export const REPORT_STATUS_COLORS: Record<MaintenanceReportStatus, { bg: string; fg: string; label: string }> = {
  open:      { bg: "#fce8e6", fg: "#c5221f", label: "Open" },
  converted: { bg: "#e6f4ea", fg: "#1e8e3e", label: "Added" },
  dismissed: { bg: "#eef1f3", fg: "#5f6368", label: "Dismissed" },
  reviewed:  { bg: "#eef1f3", fg: "#5f6368", label: "Dismissed" },
};

/** Left-stripe and chip color per priority. Bright at urgent, neutral at low. */
export const PRIORITY_COLORS: Record<MaintenancePriority, { stripe: string; chipBg: string; chipFg: string; label: string }> = {
  urgent: { stripe: "#ea4335", chipBg: "#fce8e6", chipFg: "#c5221f", label: "Urgent" },
  high:   { stripe: "#f9ab00", chipBg: "#fef7e0", chipFg: "#b06000", label: "High"   },
  normal: { stripe: "#1a73e8", chipBg: "#e8f0fe", chipFg: "#1967d2", label: "Normal" },
  low:    { stripe: "#9aa0a6", chipBg: "#eef1f3", chipFg: "#5f6368", label: "Low"    },
};

// ── Small components ──────────────────────────────────────────────────

export function StatusPill({ status }: { status: MaintenanceActionStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <View style={{
      paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999,
      backgroundColor: c.bg,
    }}>
      <Text style={[txt(800), { fontSize: 10, color: c.fg, letterSpacing: 0.3 }]}>
        {c.label.toUpperCase()}
      </Text>
    </View>
  );
}

export function ReportStatusPill({ status }: { status: MaintenanceReportStatus }) {
  const c = REPORT_STATUS_COLORS[status] ?? REPORT_STATUS_COLORS.dismissed;
  return (
    <View style={{
      paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999,
      backgroundColor: c.bg,
    }}>
      <Text style={[txt(800), { fontSize: 10, color: c.fg, letterSpacing: 0.3 }]}>
        {c.label.toUpperCase()}
      </Text>
    </View>
  );
}

export function PriorityChip({ priority }: { priority: MaintenancePriority }) {
  const c = PRIORITY_COLORS[priority];
  return (
    <View style={{
      paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999,
      backgroundColor: c.chipBg,
    }}>
      <Text style={[txt(700), { fontSize: 10, color: c.chipFg }]}>
        {c.label}
      </Text>
    </View>
  );
}

// ── Formatters ────────────────────────────────────────────────────────

export function fmtCost(cost: number | null | undefined): string | null {
  if (cost == null || Number.isNaN(cost)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(cost);
}

/** Same naive-string convention as Load times — "YYYY-MM-DD" stored as
 *  org-local. Reformat for display ("Fri, May 29"). Returns null on
 *  empty / undefined. */
export function fmtScheduledDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(`${date}T12:00:00`); // noon avoids TZ rollover
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

/** Human-friendly relative phrase ("Today" / "Tomorrow" / "in 3 days" /
 *  "5 days ago"). dateKey is YYYY-MM-DD; nowKey is YYYY-MM-DD computed
 *  in the org's TZ. Same-day comparisons happen on strings to dodge
 *  DST. */
export function fmtRelativeDay(dateKey: string, nowKey: string): string {
  if (dateKey === nowKey) return "Today";
  const a = new Date(`${dateKey}T12:00:00`).getTime();
  const b = new Date(`${nowKey}T12:00:00`).getTime();
  const diffDays = Math.round((a - b) / (24 * 60 * 60 * 1000));
  if (diffDays === 1)  return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays > 0)    return `In ${diffDays} days`;
  return `${Math.abs(diffDays)} days ago`;
}

/** "May 29 · 3:42 PM" for a full ISO timestamp. Used for "reportedAt"
 *  on driver reports. Falls back to "—" on parse failure. */
export function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}
