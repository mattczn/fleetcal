/**
 * Railway API contract types — request and response shapes for endpoints
 * that the frontends call.
 *
 * Naming convention:
 *   <Verb><Entity>Request   — POST/PATCH bodies
 *   <Verb><Entity>Response  — successful response payload
 *
 * Group related shapes under section headers. Keep alphabetized within
 * each section.
 */

import type { Accessorial, Asset, CheckCall, Customer, Dispatcher, Driver, InternalNote, Load, LoadAuditEntry, OrgSettings, PayrollAdjustment, PayrollRecord, RefNum, SavedLocation, Stop, Trailer } from "./domain";
import type { CheckCallChannel, CheckCallParty, LoadStatus, RelayRole, TrailerCategory } from "./enums";

// ── /v1/health ──────────────────────────────────────────────────────────

export interface HealthResponse {
  ok: true;
  service: "fleetcal-api";
  version: string;
  timestamp: string;
}

// ── /v1/loads ───────────────────────────────────────────────────────────

/**
 * Load-level fields submitted with `POST /v1/loads`. The server fills in
 * `id`, `internal_load_id` (via DB trigger), `created_at`/`updated_at`,
 * and the audit_log start.
 */
export interface CreateLoadRequestLoad {
  loadNum?: string;
  broker?: string;
  customerId?: string;          // uuid FK → customers
  dispatcher?: string;
  loadPrice?: number;
  commodity?: string;
  weight?: number;              // lbs
  rateConPdf?: string;          // Storage path in `rate-cons` bucket
  accessorials?: Accessorial[];
  refNums?: RefNum[];
  notes?: string;               // load-level notes
  internalNotes?: InternalNote[]; // internal-only dispatch note thread
  createdByName?: string;
}

/**
 * Per-event (per-leg) fields. For a single-event load, send one entry.
 * For a relay load, send two — both with `relayRole` set, one 'pickup'
 * and one 'delivery'.
 */
export interface CreateLoadRequestEvent {
  title: string;
  start: string;                // YYYY-MM-DDTHH:mm
  end: string;
  assetId: number;              // FK → assets
  driverId?: number;
  driverName?: string;
  status?: LoadStatus;          // defaults to 'scheduled'
  relayRole?: RelayRole;        // required if events.length === 2
  trailerId?: number;
  trailerType?: string;
  driverPay?: number;
  eventNotes?: string;          // events.notes — leg-level operational notes
  priority?: boolean;
  stops?: Stop[];               // per-leg stops (no eventId; server fills it)
}

export interface CreateLoadRequest {
  load: CreateLoadRequestLoad;
  events: CreateLoadRequestEvent[]; // 1 or 2 entries
}

/**
 * Response: the joined view, one Load entry per event. Single-event load
 * returns one entry; relay load returns two with the same loadId and
 * internalLoadId.
 */
export interface CreateLoadResponse {
  loads: Load[];
}

// ── GET /v1/loads (list) ────────────────────────────────────────────────

/**
 * Query params (all optional):
 *   from           — lower bound on events.start, YYYY-MM-DD or YYYY-MM-DDTHH:mm
 *   to             — upper bound on events.end, same format
 *   status         — comma-separated LoadStatus values
 *   assetId        — comma-separated asset ids (numeric)
 *   includeDeleted — "true" to include soft-deleted, default excluded
 */
export interface ListLoadsResponse {
  loads: Load[];
}

// ── GET /v1/loads/search ────────────────────────────────────────────────

/**
 * Query params:
 *   q     — search string (min 2 chars; shorter returns empty)
 *   limit — max results, default 20, capped server-side at 50
 *
 * Matches load-level fields (load_num, broker, notes, internal_load_id if
 * numeric) and event-level fields (title, driver_name, notes). Excludes
 * soft-deleted; results sorted newest start first.
 *
 * Stops are NOT populated on search results — callers refetch via
 * GET /v1/loads/:id when the user clicks a result.
 */
export type SearchLoadsResponse = ListLoadsResponse;

// ── GET /v1/loads/:id (single, by load uuid) ────────────────────────────

export interface GetLoadResponse {
  loads: Load[]; // 1 entry for single-event load, 2 for relay
}

// ── GET /v1/events/:id (single event by event id, with its load + stops) ─
//
// The mobile dispatch app navigates by event id (its URL param). This
// returns the same shape as GetLoadResponse: 1 entry for a single load,
// 2 entries when the event is part of a relay (the partner is included
// via the shared loads.id grouping).

export type GetEventResponse = GetLoadResponse;

// ── PATCH /v1/loads/:id (update load-level fields) ──────────────────────

export interface UpdateLoadRequest {
  loadNum?:        string | null;
  broker?:         string | null;
  customerId?:     string | null;
  dispatcher?:     string | null;
  loadPrice?:      number | null;
  commodity?:      string | null;
  weight?:         number | null;
  rateConPdf?:     string | null;
  accessorials?:   Accessorial[] | null;
  refNums?:        RefNum[] | null;
  notes?:          string | null;
  /** Full replacement of loads.internal_notes. Caller fetches, appends/edits, sends. */
  internalNotes?:  InternalNote[] | null;
  /** Full replacement of loads.audit_log. Caller fetches, appends, sends. */
  auditLog?:       LoadAuditEntry[] | null;
}

export interface UpdateLoadResponse {
  loads: Load[];
}

// ── PATCH /v1/loads/:id/events/:eventId ─────────────────────────────────

export interface UpdateEventRequest {
  title?:        string;
  start?:        string;
  end?:          string;
  status?:       LoadStatus;
  assetId?:      number;
  driverId?:     number | null;
  driverName?:   string | null;
  trailerId?:    number | null;
  trailerType?:  string | null;
  driverPay?:    number | null;
  eventNotes?:   string | null;
  priority?:     boolean;
}

export interface UpdateEventResponse {
  loads: Load[];
}

// ── POST /v1/loads/:id/split-relay ──────────────────────────────────────

/**
 * Convert a single-event load into a relay (2-event) load.
 *
 * The existing event becomes the pickup leg (gets relay_role='pickup' and
 * its end clamped to `pickupEnd`). A new event is created as the delivery
 * leg with `relay_role='delivery'` and the supplied delivery scheduling +
 * driver/asset assignment. Stops are partitioned by `relayStopIndex`:
 * indices [0..relayStopIndex] go to the pickup leg, [relayStopIndex+1..end]
 * go to the delivery leg. The relay handoff stop is typically at index
 * `relayStopIndex`.
 */
export interface SplitRelayRequest {
  pickupEnd:           string;        // YYYY-MM-DDTHH:mm
  deliveryStart:       string;
  deliveryEnd:         string;
  deliveryAssetId:     number;
  deliveryDriverId?:   number | null;
  deliveryDriverName?: string | null;
  /** Full ordered stop list after the split. */
  mergedStops:         Stop[];
  /** Index of the last stop on the pickup leg (the relay handoff). */
  relayStopIndex:      number;
}

export interface SplitRelayResponse {
  loads: Load[]; // 2 entries: pickup leg, delivery leg
}

// ── POST /v1/loads/:id/unsplit-relay ────────────────────────────────────

/**
 * Inverse of split-relay: collapse a 2-event relay load back to a single
 * event. `keepEventId` specifies which leg survives; the other is
 * soft-deleted. The kept event has `relay_role` cleared and its end
 * extended to the later of the two ends. If `mergedStops` is supplied
 * the kept event's stops are replaced with that list (sequence rewritten
 * 1..N); otherwise the kept event keeps its existing stops as-is.
 */
export interface UnsplitRelayRequest {
  keepEventId: string;
  mergedStops?: Stop[];
}

export interface UnsplitRelayResponse {
  loads: Load[]; // single entry — the surviving event with its load
}

// ── DELETE /v1/loads/:id (soft-delete) ──────────────────────────────────

export interface DeleteLoadResponse {
  ok:     true;
  loadId: string;
}

// ── POST /v1/loads/:id/restore ──────────────────────────────────────────

export interface RestoreLoadResponse {
  loads: Load[];
}

// ── /v1/events ──────────────────────────────────────────────────────────
//
// Event endpoints. Useful for non-revenue events (which have no parent
// load) and as a load-id-agnostic way to address any event.

/**
 * Create a non-revenue event. Maintenance/Trailer Move/Drop Trailer/
 * Deadhead/Training/Inspection/Other.
 */
export interface CreateEventRequest {
  title:           string;
  start:           string;
  end:             string;
  assetId:         number;
  nonRevenueType:  string;
  driverId?:       number;
  driverName?:     string;
  status?:         LoadStatus;        // defaults to 'scheduled'
  trailerId?:      number;
  trailerType?:    string;
  driverPay?:      number;
  eventNotes?:     string;
  priority?:       boolean;
  stops?:          Stop[];            // rare for non-revenue but allowed
}

export interface CreateEventResponse {
  loads: Load[];                       // single entry; loadId undefined
}

/**
 * Update any event (revenue or non-revenue) by its uuid. For revenue
 * events, this is interchangeable with PATCH /v1/loads/:loadId/events/:eventId.
 */
export interface UpdateEventByIdRequest {
  title?:        string;
  start?:        string;
  end?:          string;
  status?:       LoadStatus;
  assetId?:      number;
  driverId?:     number | null;
  driverName?:   string | null;
  trailerId?:    number | null;
  trailerType?:  string | null;
  driverPay?:    number | null;
  eventNotes?:   string | null;
  priority?:     boolean;
  nonRevenueType?: string | null;     // only meaningful when event_kind='non_revenue'
}

export interface UpdateEventByIdResponse {
  loads: Load[];                       // single entry (the updated event with its load joined if revenue)
}

/**
 * Soft-delete a non-revenue event. For revenue-event delete (which is a
 * leg of a load), use DELETE /v1/loads/:loadId — that deletes the load
 * and both its events.
 */
export interface DeleteEventResponse {
  ok:      true;
  eventId: string;
}

/**
 * Replace all stops for an event with the supplied ordered list.
 * Sequence is rewritten 1..N from array order; caller doesn't manage it.
 */
export interface ReplaceStopsRequest {
  stops: Stop[];
}

export interface ReplaceStopsResponse {
  loads: Load[];                       // single entry, with new stops populated
}

// ── GET /v1/loads/:id/rate-con-url ──────────────────────────────────────

/**
 * Returns a viewable URL for the load's rate-con PDF.
 *   • Storage-path values → 1-hour signed URL from the `rate-cons` bucket
 *   • Legacy data: URLs    → returned as-is
 *   • No rate-con on file  → { url: null }
 */
export interface GetRateConUrlResponse {
  url: string | null;
}

// ── GET /v1/events/:id/audit-log ────────────────────────────────────────

/**
 * Returns the audit log entries relevant to this event:
 *   • Revenue events → loads.audit_log of the parent load (load-level
 *     audit such as broker/accessorial/load-price changes), merged with
 *     events.audit_log (per-leg driver-side entries like check-ins),
 *     sorted by changedAt ascending.
 *   • Non-revenue events → events.audit_log only.
 */
export interface GetAuditLogResponse {
  entries: LoadAuditEntry[];
}

// ── /v1/documents ────────────────────────────────────────────────────────

export type DocumentKind = "bol" | "pod" | "scale" | "other";

/**
 * Document summary shape returned by list/show endpoints. `signedUrl` is
 * populated by the list endpoint (1-hour signed URL minted server-side);
 * call GET /v1/documents/:id/url to mint a fresh one.
 */
export interface DocumentSummary {
  id:          string;
  loadId:      string | null;        // null for legacy non-revenue-event docs
  fileName:    string;
  mimeType?:   string;
  sizeBytes?:  number;
  kind:        DocumentKind;
  uploadedAt:  string;
  signedUrl?:  string;
}

// GET /v1/loads/:loadId/documents
export interface ListDocumentsResponse {
  documents: DocumentSummary[];
}

// GET /v1/documents/:id/url
export interface GetDocumentUrlResponse {
  url: string | null;
}

// ── /v1/assets ───────────────────────────────────────────────────────────

export interface ListAssetsResponse { assets: Asset[]; }
export interface CreateAssetRequest {
  name:             string;
  color:            string;
  type:             string;
  unit?:            string | null;
  truck?:           string | null;
  notes?:           string | null;
  hidden?:          boolean;
  motiveVehicleId?: string | null;
  /** Optional explicit sort_order; otherwise the server appends to the end. */
  sortOrder?:       number;
}
export interface CreateAssetResponse { asset: Asset; }
export interface UpdateAssetRequest  {
  name?:            string;
  color?:           string;
  type?:            string;
  unit?:            string | null;
  truck?:           string | null;
  notes?:           string | null;
  hidden?:          boolean;
  motiveVehicleId?: string | null;
  sortOrder?:       number;
}
export interface UpdateAssetResponse { asset: Asset; }
/** Reorder assets in one shot. The server writes sort_order = index for each id. */
export interface ReorderAssetsRequest { ids: number[]; }

// ── /v1/drivers ──────────────────────────────────────────────────────────

export interface ListDriversResponse { drivers: Driver[]; }
export interface CreateDriverRequest {
  name:       string;
  firstName?: string | null;
  lastName?:  string | null;
  phone?:     string | null;
  notes?:     string | null;
}
export interface CreateDriverResponse { driver: Driver; }
export interface UpdateDriverRequest {
  name?:      string;
  firstName?: string | null;
  lastName?:  string | null;
  phone?:     string | null;
  notes?:     string | null;
}
export interface UpdateDriverResponse { driver: Driver; }

// ── /v1/customers ────────────────────────────────────────────────────────

export interface ListCustomersResponse { customers: Customer[]; }
export interface CreateCustomerRequest {
  name:           string;
  shortName?:     string | null;
  aliases?:       string[];
  mcNum?:         string | null;
  contactName?:   string | null;
  contactEmail?:  string | null;
  contactPhone?:  string | null;
  notes?:         string | null;
  parseHints?:    string | null;
}
export interface CreateCustomerResponse { customer: Customer; }
export interface UpdateCustomerRequest {
  name?:          string;
  shortName?:     string | null;
  aliases?:       string[];
  mcNum?:         string | null;
  contactName?:   string | null;
  contactEmail?:  string | null;
  contactPhone?:  string | null;
  notes?:         string | null;
  parseHints?:    string | null;
}
export interface UpdateCustomerResponse { customer: Customer; }

// ── /v1/trailers ─────────────────────────────────────────────────────────

export interface ListTrailersResponse { trailers: Trailer[]; }
export interface CreateTrailerRequest {
  name:             string;
  trailerNumber?:   string | null;
  category:         TrailerCategory;
  notes?:           string | null;
  motiveVehicleId?: string | null;
}
export interface CreateTrailerResponse { trailer: Trailer; }
export interface UpdateTrailerRequest {
  name?:            string;
  trailerNumber?:   string | null;
  category?:        TrailerCategory;
  notes?:           string | null;
  motiveVehicleId?: string | null;
}
export interface UpdateTrailerResponse { trailer: Trailer; }

// ── /v1/dispatchers ──────────────────────────────────────────────────────

export interface ListDispatchersResponse { dispatchers: Dispatcher[]; }
export interface CreateDispatcherRequest {
  name:       string;
  isDefault?: boolean;
}
export interface CreateDispatcherResponse { dispatcher: Dispatcher; }
export interface UpdateDispatcherRequest {
  name?:      string;
  isDefault?: boolean;
}
export interface UpdateDispatcherResponse { dispatcher: Dispatcher; }

// ── /v1/driver-asset-prefs ───────────────────────────────────────────────
//
// Asset → preferred driver mapping (one preferred driver per asset).
// Stored in the driver_asset_prefs table; PK is asset_id.

export interface DriverAssetPref { assetId: number; driverId: number; }
export interface ListDriverAssetPrefsResponse { prefs: DriverAssetPref[]; }
export interface SetDriverAssetPrefRequest { driverId: number; }
export interface SetDriverAssetPrefResponse { pref: DriverAssetPref; }

// ── /v1/saved-locations ──────────────────────────────────────────────────

export interface ListSavedLocationsResponse { locations: SavedLocation[]; }
export interface CreateSavedLocationRequest {
  name:      string;
  address?:  string | null;
  lat?:      number | null;
  lng?:      number | null;
  timezone?: string | null;
}
export interface CreateSavedLocationResponse { location: SavedLocation; }
export interface UpdateSavedLocationRequest {
  name?:     string;
  address?:  string | null;
  lat?:      number | null;
  lng?:      number | null;
  timezone?: string | null;
}
export interface UpdateSavedLocationResponse { location: SavedLocation; }

// ── /v1/payroll ─────────────────────────────────────────────────────────

// Query params:
//   weekStart? — filter to one week (YYYY-MM-DD)
//   driverName? — filter to one driver
export interface ListPayrollAdjustmentsResponse { adjustments: PayrollAdjustment[]; }
export interface CreatePayrollAdjustmentRequest {
  driverName:   string;
  weekStart:    string;
  category:     string;
  description?: string | null;
  amount:       number;
}
export interface CreatePayrollAdjustmentResponse { adjustment: PayrollAdjustment; }

// Query params:
//   driverName  — required when listing
//   weekStart?  — filter to a single week
export interface ListPayrollRecordsResponse { records: PayrollRecord[]; }
export interface UpsertPayrollRecordRequest {
  driverName: string;
  weekStart:  string;
  totalPay:   number;
  notes?:     string | null;
}
export interface UpsertPayrollRecordResponse { record: PayrollRecord; }

// ── /v1/org-settings ────────────────────────────────────────────────────

export interface GetOrgSettingsResponse { settings: OrgSettings; }
export interface UpdateOrgSettingsRequest {
  showDriverPay?:    boolean;
  rateConSettings?:  import("./domain").RateConSettings | null;
}
export interface UpdateOrgSettingsResponse { settings: OrgSettings; }

// ── /v1/stops/recent ────────────────────────────────────────────────────
//
// Returns recently-used distinct facility / address combos from the org's
// stops history, matching `q` (ilike facility_name or address). Deduped by
// (facility_name, address); ordered by most-recent stop first.

export interface RecentStop {
  facilityName?: string;
  address?:      string;
  city?:         string;
  state?:        string;
  lat?:          number;
  lng?:          number;
  timezone?:     string;
}

export interface ListRecentStopsResponse {
  recentStops: RecentStop[];
}

// ── /v1/loads/:loadId/check-calls ───────────────────────────────────────

export interface ListCheckCallsResponse { checkCalls: CheckCall[]; }

export interface CreateCheckCallRequest {
  channel:      CheckCallChannel;
  withParty:    CheckCallParty;
  body:         string;
  /** Display name of the dispatcher who is logging the entry. */
  byName:       string;
  /** Optional ISO timestamp; defaults to "now" server-side. */
  ts?:          string;
  /** Optional ISO timestamp for when the next check-in is due. */
  nextCheckAt?: string;
}

export interface CreateCheckCallResponse { checkCall: CheckCall; }

// ── Errors (shared envelope) ────────────────────────────────────────────

export interface ApiErrorResponse {
  error: string;
  reason?: string;
  detail?: string;
  errors?: string[];
}
