/**
 * Web-app type re-exports.
 *
 * Domain types now live in @fleetcal/types. Each entity is re-exported here
 * so existing `from './types'` callers don't have to change. A few names
 * are aliased for backwards compatibility (CalendarEvent = Load,
 * EventStatus = LoadStatus).
 *
 * Web-only types (Dispatcher, Customer, SavedLocation) stay defined here.
 */

import type { Load, LoadStatus } from "@fleetcal/types";

// Domain — re-exports from @fleetcal/types
export type {
  Load,
  LoadStatus,
  StopType,
  NonRevenueType,
  Stop,
  Driver,
  Asset,
  Trailer,
  TrailerCategory,
  RefNum,
  Accessorial,
  AccessorialCategory,
  AccessorialChange,
  LoadAuditEntry,
  GeocodeStatus,
} from "@fleetcal/types";
export { NON_REVENUE_TYPES } from "@fleetcal/types";

// Backwards-compatible aliases for existing web code
export type CalendarEvent = Load;
export type EventStatus = LoadStatus;

// ── Web-only types ──────────────────────────────────────────────────────

import type { Customer as _Customer } from "@fleetcal/types";
export type { Customer, Dispatcher, SavedLocation } from "@fleetcal/types";

export type CustomerMatchResult =
  | { status: "auto";    customer: _Customer; score: number }
  | { status: "confirm"; customer: _Customer; score: number }
  | { status: "new";     extracted: string }
  | { status: "none" };
