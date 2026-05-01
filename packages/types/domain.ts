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

import type { LoadStatus, StopType, GeocodeStatus, TrailerCategory } from "./enums";

// ── Refs / enums (small) ────────────────────────────────────────────────

export interface RefNum {
  label: string;
  value: string;
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
  lat?: number;
  lng?: number;
  timezone?: string;
  apptStart?: string;
  apptEnd?: string;
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

// ── Load — canonical app-domain shape for events table rows ─────────────
//
// Web app calls this CalendarEvent (kept as an alias in apps/web/lib/types.ts).
// Mobile apps already call it Load. Fields are the union of all current usage;
// most are optional because not every render path needs every column. Some
// fields (commodity, miles, weight, pickupCity, etc.) reference DB columns
// that were removed during schema cleanup — they're kept here for now to
// avoid breaking mobile code that still reads them. See MIGRATION-FOLLOWUPS.md.

export interface Load {
  // Identity
  id: string;
  internalLoadId?: number;
  loadNum?: string;

  // Calendar / scheduling
  title: string;
  start: string; // YYYY-MM-DDTHH:mm (naive, dispatch zone)
  end: string;
  status: LoadStatus;
  priority?: boolean;
  eventKind?: "revenue" | "non_revenue";
  nonRevenueType?: string;

  // People
  driverId?: number;
  driverName?: string;
  driverPhone?: string;
  dispatcher?: string;
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

  // Load info (some legacy)
  broker?: string;
  commodity?: string; // legacy column
  weight?: number; // legacy column
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
  notes?: string;
  specialInstructions?: string;
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
}
