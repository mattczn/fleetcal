/**
 * App-domain types — camelCase shapes used by frontend code.
 *
 * Distinct from the snake_case Row/Insert/Update types generated from the
 * Postgres schema (re-exported from index.ts). Converters in ./converters
 * map between the two.
 *
 * Sourced from apps/web/lib/types.ts (the most-complete pre-Phase-1 set).
 * Mobile-specific fields are merged in as optional. Several fields here
 * reference DB columns that have been dropped — see MIGRATION-FOLLOWUPS.md.
 */

import type { LoadStatus, StopType, ScheduleType, GeocodeStatus, TrailerCategory, CheckCallChannel, CheckCallParty } from "./enums";

// ── Refs / enums (small) ────────────────────────────────────────────────

export interface RefNum {
  label: string;
  value: string;
}

export interface InternalNote {
  id:     string;        // client-generated uuid for stable list keys
  text:   string;
  author: string | null; // display name of who wrote it
  at:     string;        // ISO timestamp the entry was posted
}

export type AccessorialCategory =
  | "detention"
  | "lumper"
  | "layover"
  | "scale_ticket"
  | "other";

export interface Accessorial {
  id: string;
  category: AccessorialCategory;
  description?: string;
  amount: number;
  billable: boolean;
  status?: "requested" | "approved" | "denied";
  /** When true, this accessorial flows into the driver's payroll as an adjustment. */
  payToDriver?: boolean;
  /** Optional: override which driver gets paid (defaults to the load's assigned driverName). Used for split/relay loads. */
  payDriverName?: string;
}

// ── Stop ────────────────────────────────────────────────────────────────

export interface Stop {
  id: string;
  /** Optional in some create-flows where the parent event isn't persisted yet. */
  eventId?: string;
  sequence: number;
  type: StopType;
  facilityName?: string;
  address?: string;
  city?: string;
  /** Two-letter state / province code (e.g. "UT", "CA") from Google's
   *  administrative_area_level_1 component. Set whenever the stop is
   *  geocoded; null on legacy rows until backfilled. */
  state?: string;
  lat?: number;
  lng?: number;
  timezone?: string;
  apptStart?: string;
  apptEnd?: string;
  /** How the appointment window should be interpreted in the UI. Null = legacy. */
  scheduleType?: ScheduleType;
  geocodeStatus?: GeocodeStatus;
  instructions?: string;
  arrivedAt?: string;
  arrivedLat?: number;
  arrivedLng?: number;
}

// ── Driver ──────────────────────────────────────────────────────────────

export interface Driver {
  id: number;
  name: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  notes?: string;
}

// ── Asset (the assets table — trucks/vehicles) ──────────────────────────

export interface Asset {
  id: number;
  name: string;
  color: string;
  type: string;
  unit?: string;
  truck?: string;
  hidden?: boolean;
  notes?: string;
  motiveVehicleId?: string;
  /** assets.sort_order — NOT NULL DEFAULT 0 in the DB; always present. */
  sortOrder: number;
}

// ── Trailer ─────────────────────────────────────────────────────────────

export interface Trailer {
  id: number;
  name: string;
  trailerNumber?: string;
  category: TrailerCategory;
  notes?: string;
  motiveVehicleId?: string;
  sortOrder?: number;
}

// ── Saved Location ──────────────────────────────────────────────────────

export interface SavedLocation {
  id: string;
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  timezone?: string;
}

// ── Payroll ─────────────────────────────────────────────────────────────

export interface PayrollAdjustment {
  id: string;
  driverName: string;
  weekStart: string;        // ISO date YYYY-MM-DD
  category: string;
  description?: string;
  amount: number;
  createdAt: string;
}

export interface PayrollRecord {
  id: string;
  driverName: string;
  weekStart: string;
  totalPay: number;
  finalizedAt: string;
  notes?: string;
}

// ── Org settings ────────────────────────────────────────────────────────

export interface OrgSettings {
  showDriverPay: boolean;
}

// ── Customer ────────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  name: string;          // canonical display name
  shortName?: string;    // abbreviated name used in auto-generated load titles
  aliases: string[];     // alternative names the AI may extract from rate-cons
  mcNum?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}

// ── Dispatcher ──────────────────────────────────────────────────────────

export interface Dispatcher {
  id: string;
  name: string;
  isDefault: boolean;
}

// ── Check call ──────────────────────────────────────────────────────────
// One logged communication tied to a load. Append-only timeline; per-org.

export interface CheckCall {
  id: string;
  loadId: string;
  /** When the communication happened (defaults to created_at). */
  ts: string;
  /** Dispatcher who logged the entry. */
  byName: string;
  channel: CheckCallChannel;
  withParty: CheckCallParty;
  body: string;
  /** Optional reminder for when the next check-in is expected. */
  nextCheckAt?: string;
  createdAt: string;
}

// ── Audit trail ─────────────────────────────────────────────────────────

export interface AccessorialChange {
  action: "added" | "removed" | "updated";
  category: string;
  description?: string;
  amount?: number;
  prevAmount?: number;
  newStatus?: string;
  prevStatus?: string;
}

export interface LoadAuditEntry {
  changedAt: string;
  changedByName: string;
  prevDriverName?: string;
  newDriverName?: string;
  prevAssetId?: number;
  newAssetId?: number;
  prevLoadPrice?: number;
  newLoadPrice?: number;
  prevDriverPay?: number;
  newDriverPay?: number;
  stopsAdded?: number;
  stopsRemoved?: number;
  relayCreated?: boolean;
  relayRemoved?: boolean;
  loadDeleted?: boolean;
  loadRestored?: boolean;
  accessorialsChanged?: AccessorialChange[];
  prevStatus?: LoadStatus;
  newStatus?: LoadStatus;
  documentUploaded?: { fileName: string; kind: string };
  documentDeleted?: { fileName: string; kind: string };
  stopCheckedIn?: { stopFacility?: string; stopType?: StopType; distanceMi?: number };
}

// ── Load — canonical app-domain shape (joined view) ─────────────────────
//
// As of Phase 2.5a, "load" is now a real DB entity (the `loads` table) and
// `events` are calendar entries that belong to a load (1 or 2 events per
// revenue load; 0 events tied to a non-revenue event). This `Load` interface
// is the JOINED VIEW that frontend code consumes — one event + its load row's
// fields merged into a single shape. Each call site that fetches loads will
// get one Load object per event row, with load-level fields populated from
// events.load_id → loads. For relay loads, two events share the same load,
// so two Load objects come back with the same load-level data but different
// per-leg fields (start/end/asset/driver/etc.).
//
// Web app calls this CalendarEvent (kept as an alias in apps/web/lib/types.ts).
// Mobile apps already call it Load.
//
// Mutations: load-level edits write to `loads`, event-level edits write to
// `events`. The mutation helpers in apps/* know which is which.
//
// Notes split:
//   - `Load.notes` is the load-level note (loads.notes) — broker instructions
//   - `Load.eventNotes` is the event-level note (events.notes) — leg ops, the
//     only notes home for non-revenue events
//
// Several "legacy" fields below reference DB columns that were dropped
// during schema cleanup or never made it to the `loads` schema (commodity,
// miles, weight, pickupCity, etc.). Kept optional so existing mobile code
// that reads them still type-checks. See MIGRATION-FOLLOWUPS.md.

export interface Load {
  // Identity
  id: string;                  // events.id (the calendar-entry id)
  loadId?: string;             // loads.id — present for revenue events, absent for non-revenue
  internalLoadId?: number;     // loads.internal_load_id (5+ digit, per-org unique)
  loadNum?: string;

  // Calendar / scheduling
  title: string;
  start: string; // YYYY-MM-DDTHH:mm (naive, dispatch zone)
  end: string;
  status: LoadStatus;
  priority?: boolean;
  eventKind?: "revenue" | "non_revenue";
  nonRevenueType?: string;

  // People & customer
  driverId?: number;
  driverName?: string;
  driverPhone?: string;
  dispatcher?: string;
  customerId?: string;       // loads.customer_id (uuid FK to customers)
  createdByName?: string;
  createdAt?: string;

  // Equipment
  assetId: number;
  assetName?: string; // joined display field — populated by mobile queries
  motiveVehicleId?: string;
  trailerId?: number;
  trailerName?: string;
  trailerNum?: string; // legacy
  trailerType?: string;

  // References
  refNums?: RefNum[];
  bolNum?: string; // legacy column
  poNum?: string; // legacy column

  // Load info
  broker?: string;
  /** What's being hauled (free text from rate-con: "Frozen produce", "Industrial parts", etc.). */
  commodity?: string;
  /** Cargo weight in lbs. */
  weight?: number;
  miles?: number; // legacy column
  teamLoad?: boolean; // legacy column
  hazmat?: boolean; // legacy column

  // Quick locations (legacy denormalized — actual stops live in `stops`)
  pickupCity?: string;
  deliveryCity?: string;
  pickupAppt?: string;
  deliveryAppt?: string;

  // Financial
  loadPrice?: number;
  driverPay?: number;
  detention?: number;
  lumperFees?: number;
  ratePerMile?: number; // legacy column
  fuelSurcharge?: number; // legacy column
  factoringCompany?: string; // legacy column
  invoiceNum?: string; // legacy column
  paymentStatus?: string; // legacy column
  /** Payroll deferral — weekStart (YYYY-MM-DD) this load's driver pay is deferred to. */
  deferredToWeek?: string;

  // State
  dispatched?: boolean; // legacy column

  // Notes & meta
  notes?: string;              // loads.notes — load-level (broker instructions)
  /**
   * Thread of internal-only dispatch notes pinned to the load. Each entry
   * is authored independently so multiple dispatchers can leave context
   * over time. Never sent to driver/broker.
   */
  internalNotes?: InternalNote[];
  eventNotes?: string;         // events.notes — event/leg-level; non-revenue's only notes home
  specialInstructions?: string; // legacy: events.special_instructions, merged into loads.notes by migration
  accessorials?: Accessorial[];
  /** Storage path in `rate-cons` bucket (legacy: base64 data URL). */
  rateConPdf?: string;

  // Stops — always an array; converters return [] when not yet loaded.
  stops: Stop[];

  // Relay (split loads)
  relayGroupId?: string;
  relayRole?: "pickup" | "delivery";
  partnerEventId?: string;
  partnerStops?: Stop[];
  partnerDriverName?: string;
  partnerAssetName?: string;

  // Audit
  auditLog?: LoadAuditEntry[];

  /** events.deleted_at — set on soft-deleted events; populated by reads
   *  that include deleted rows (trash UI). */
  deletedAt?: string;
}
