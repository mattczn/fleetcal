/**
 * Domain enums shared across all FleetCal apps.
 *
 * These are app-level enums that don't come from a Supabase generated type:
 * they describe text columns where the database stores free-form text but
 * the application has a closed set of valid values.
 */

// ── Load status ─────────────────────────────────────────────────────────
// Lifecycle of a load (events.status column).
// Order roughly matches happy-path progression; off-path values at the end.

export const LOAD_STATUSES = [
  "scheduled",
  "dispatched",
  "en_route",
  "picked_up",
  "delivered",
  "cancelled",
  "tonu",
  "problem",
] as const;

export type LoadStatus = (typeof LOAD_STATUSES)[number];

export function isLoadStatus(v: unknown): v is LoadStatus {
  return typeof v === "string" && (LOAD_STATUSES as readonly string[]).includes(v);
}

// ── Stop type ───────────────────────────────────────────────────────────
// stops.type column.

export const STOP_TYPES = [
  "pickup",
  "delivery",
  "drop",
  "drop_hook",
  "stop",
  "relay",
] as const;

export type StopType = (typeof STOP_TYPES)[number];

// ── Schedule type ───────────────────────────────────────────────────────
// stops.schedule_type column. Describes how the apptStart/apptEnd window
// should be read in the UI; null = legacy ("appointment" if only apptStart,
// "window" if both).

export const SCHEDULE_TYPES = ["appointment", "window", "fcfs"] as const;

export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

// ── Trailer category ────────────────────────────────────────────────────
// trailers.category column.

export const TRAILER_CATEGORIES = [
  "Swing",
  "Roll Up",
  "Flat Bed",
  "Other",
] as const;

export type TrailerCategory = (typeof TRAILER_CATEGORIES)[number];

// ── Non-revenue event type ──────────────────────────────────────────────
// events.non_revenue_type column. Only meaningful when event_kind = 'non_revenue'.

export const NON_REVENUE_TYPES = [
  "Maintenance",
  "Trailer Move",
  "Drop Trailer",
  "Deadhead",
  "Training",
  "Inspection",
  "Other",
] as const;

export type NonRevenueType = (typeof NON_REVENUE_TYPES)[number];

// ── Geocode status ──────────────────────────────────────────────────────
// stops.geocode_status column.

export const GEOCODE_STATUSES = ["pending", "success", "failed"] as const;

export type GeocodeStatus = (typeof GEOCODE_STATUSES)[number];

// ── Event kind ──────────────────────────────────────────────────────────
// events.event_kind column. Distinguishes paying loads from non-revenue moves.

export const EVENT_KINDS = ["revenue", "non_revenue"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

// ── Relay role ──────────────────────────────────────────────────────────
// events.relay_role column. Only set when relay_group_id is non-null.

export const RELAY_ROLES = ["pickup", "delivery"] as const;

export type RelayRole = (typeof RELAY_ROLES)[number];
