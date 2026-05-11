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

import type { Accessorial, Asset, CheckCall, Customer, Dispatcher, Driver, InternalNote, Invoice, InvoiceLineItem, InvoiceStatus, Load, LoadAuditEntry, OrgSettings, PayrollAdjustment, PayrollRecord, RefNum, SavedLocation, Stop, Trailer } from "./domain";
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
  rateConPdf?: string | null;   // Storage path in `rate-cons` bucket; null is harmless on create
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
  loadedMiles?: number;         // routed road miles for this leg (cached)
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
  loadedMiles?:  number | null;
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
  loadedMiles?:  number | null;
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

/**
 * Standardized document categories for the closeout workflow. Anything
 * that doesn't fit one of these slots goes under "other"; the UI keeps
 * a free-text description field separate so users can disambiguate
 * within a category without polluting the kind enum (which the
 * verification checklist and invoice-packet logic depend on).
 *
 *   rate_con     — broker rate confirmation; primary one is mirrored
 *                  onto loads.rate_con_pdf, history lives here
 *   pod          — proof of delivery (required for release)
 *   bol          — bill of lading
 *   scale        — scale ticket (required when load has scale_ticket
 *                  accessorial)
 *   lumper       — lumper receipt (required when load has lumper
 *                  accessorial)
 *   receipt      — generic receipt (fuel, layover, etc.)
 *   driver_sheet — driver pay sheet / trip sheet
 *   invoice      — already-built invoice for this load
 *   other        — anything else
 */
export type DocumentKind =
  | "rate_con"
  | "pod"
  | "bol"
  | "scale"
  | "lumper"
  | "receipt"
  | "driver_sheet"
  | "invoice"
  | "other";

/** Canonical ordered list — drives the UI chip order and validation. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "rate_con", "pod", "bol", "scale", "lumper", "receipt", "driver_sheet", "invoice", "other",
];

/**
 * Document summary shape returned by list/show endpoints. `signedUrl` is
 * populated by the list endpoint (1-hour signed URL minted server-side);
 * call GET /v1/documents/:id/url to mint a fresh one.
 *
 * `invoiceId` is set when the doc is the archived PDF of a generated
 * invoice (kind === 'invoice', column load_documents.invoice_id). Web
 * uses it to dedupe against the virtual invoice rows the docs panel
 * renders from /v1/invoices.
 */
export interface DocumentSummary {
  id:          string;
  loadId:      string | null;        // null for legacy non-revenue-event docs
  invoiceId?:  string;               // set when kind='invoice' (Phase-4 packet archive)
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
  name:                 string;
  shortName?:           string | null;
  aliases?:             string[];
  mcNum?:               string | null;
  contactName?:         string | null;
  contactEmail?:        string | null;
  contactPhone?:        string | null;
  notes?:               string | null;
  parseHints?:          string | null;
  invoiceMethod?:       'email' | 'portal' | null;
  invoiceEmail?:        string | null;
  invoicePortal?:       string | null;
  invoiceInstructions?: string | null;
}
export interface CreateCustomerResponse { customer: Customer; }
export interface UpdateCustomerRequest {
  name?:                string;
  shortName?:           string | null;
  aliases?:             string[];
  mcNum?:               string | null;
  contactName?:         string | null;
  contactEmail?:        string | null;
  contactPhone?:        string | null;
  notes?:               string | null;
  parseHints?:          string | null;
  invoiceMethod?:       'email' | 'portal' | null;
  invoiceEmail?:        string | null;
  invoicePortal?:       string | null;
  invoiceInstructions?: string | null;
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
  invoiceSettings?:  import("./domain").InvoiceSettings | null;
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

// ── /v1/invoices ────────────────────────────────────────────────────────
//
// Invoicing lifecycle is per-load: generate → (preview / edit) → send →
// (paid | void). All endpoints scope to the caller's org; load_id must
// belong to the org or 404.

/**
 * Body for POST /v1/invoices. Most fields are optional — when omitted
 * the server derives them from the load and org_settings. Only the
 * load_id is required; everything else is a hook for the editing UI
 * to override before the snapshot is frozen.
 */
export interface CreateInvoiceRequest {
  loadId:           string;
  /** Override the invoice number. Defaults to internal_load_id with
   *  the org's invoice_number_prefix. */
  invoiceNumber?:   string;
  /** Override line items. Default: linehaul + billable accessorials. */
  lineItems?:       InvoiceLineItem[];
  /** Override due date. Default: issued + default_payment_terms_days. */
  dueAt?:           string;
  /** Override remit-to. Default: org_settings.invoice_settings.remit_to_instructions. */
  remitToInstructions?: string;
  /** Override footer notes. Default: org_settings.invoice_settings.invoice_footer_notes. */
  invoiceFooterNotes?:  string;
}

export interface CreateInvoiceResponse { invoice: Invoice; }

/**
 * GET /v1/invoices query params (all optional):
 *   status   — comma-separated InvoiceStatus values
 *   loadId   — filter to one load
 *   brokerId — filter to one customer (uuid)
 *   from     — issued_at >= this timestamp / date
 *   to       — issued_at <= this timestamp / date
 */
export interface ListInvoicesResponse { invoices: Invoice[]; }

export interface GetInvoiceResponse { invoice: Invoice; }

/**
 * Patch a draft invoice. Only allowed while status === 'draft' (server
 * enforces). Sent/paid/void invoices are immutable from this endpoint
 * — use the action endpoints for state transitions.
 */
export interface UpdateInvoiceRequest {
  invoiceNumber?:       string;
  lineItems?:           InvoiceLineItem[];
  dueAt?:               string | null;
  remitToInstructions?: string | null;
  invoiceFooterNotes?:  string | null;
}

export interface UpdateInvoiceResponse { invoice: Invoice; }

/**
 * POST /v1/invoices/:id/send — send and/or mark sent.
 *
 *   method='email'  → render PDF, attach optional bundle, fire via SMTP,
 *                     flip status to 'sent' on success. `to` required.
 *   method='portal' → just flip status (broker has their own portal).
 *   method='manual' → just flip status (user sent it externally).
 *
 * For 'email':
 *   - `to` defaults to the customer's invoice_email if you pass null/empty
 *     (server resolves). If neither exists the request fails 400.
 *   - `cc` / `bccSelf` are optional. bccSelf = true sends a copy to the
 *     calling user's email (so they have a paper trail).
 *   - `attachLoadDocs` defaults to true — auto-attaches the most-recent
 *     POD/BOL/lumper/scale uploads for the load.
 *   - `bodyText` overrides the auto-generated message body.
 */
export interface SendInvoiceRequest {
  method:          'email' | 'portal' | 'manual';
  to?:             string;
  cc?:             string[];
  bccSelf?:        boolean;
  bodyText?:       string;
  attachLoadDocs?: boolean;
}

export interface SendInvoiceResponse { invoice: Invoice; }

/**
 * POST /v1/invoices/batch-generate — generate an invoice for each
 * supplied loadId. Optionally fires the batch-send flow against the
 * just-created drafts (Alvys's "Create & Send" button).
 *
 * Per-load failure isolation: a single load that 409's (active
 * invoice already exists) or otherwise errors does NOT abort the
 * batch. The response reports per-load results so the UI can surface
 * exactly which loads landed and which need follow-up.
 *
 * When thenSend is true, the second-stage call mirrors the standalone
 * batch-send shape (groups[] by broker). Loads whose generation
 * failed are excluded from the send phase.
 */
export interface BatchGenerateInvoicesRequest {
  loadIds:    string[];
  /** Render + email each just-created invoice to its broker, grouped
   *  per-broker into a single email with N packet attachments. */
  thenSend?:  boolean;
  /** Forwarded to the second-stage batch-send when thenSend=true. */
  cc?:             string[];
  bccSelf?:        boolean;
  bodyText?:       string;
  attachLoadDocs?: boolean;
}

export interface BatchGenerateInvoicesResponse {
  created: Array<{ loadId: string; invoice: Invoice }>;
  failed:  Array<{ loadId: string; error: string }>;
  /** Populated only when thenSend was requested. Same shape as
   *  BatchSendInvoicesResponse.groups. */
  sent?:   BatchSendInvoicesResponse['groups'];
}

/**
 * POST /v1/invoices/batch-send — send a set of draft invoices grouped
 * by broker (one email per unique broker, all of that broker's
 * selected drafts as separate packet attachments).
 *
 *   - All invoice ids must reference DRAFT invoices in the caller's
 *     org. Mixed-status sets fail 400.
 *   - All invoices must have a customer_id (no anonymous-broker
 *     batches). Invoices missing customer_id fail 400.
 *   - Per-broker recipient = customer.invoice_email. Brokers without
 *     a saved invoice_email are reported in `skipped` and their
 *     invoices stay in draft.
 *   - On any group's send failure, ONLY that broker's invoices stay
 *     in draft; successful groups still flip to sent. The response
 *     reports per-group status so the UI can show what shipped.
 */
export interface BatchSendInvoicesRequest {
  invoiceIds: string[];
  cc?:        string[];
  bccSelf?:   boolean;
  bodyText?:  string;
  attachLoadDocs?: boolean;
}

export interface BatchSendInvoicesResponse {
  /** Per-broker group results, in arbitrary order. */
  groups: Array<{
    customerId:  string;
    brokerName:  string;
    to:          string | null;
    /** 'sent', 'skipped_no_email', 'failed'. */
    status:      'sent' | 'skipped_no_email' | 'failed';
    invoiceIds:  string[];
    error?:      string;
    messageId?:  string;
  }>;
}

/** POST /v1/invoices/:id/mark-paid */
export interface MarkInvoicePaidRequest {
  paidAt?:  string;
  amount?:  number;
  method?:  'ach' | 'check' | 'wire' | 'other';
  note?:    string;
}
export interface MarkInvoicePaidResponse { invoice: Invoice; }

/** POST /v1/invoices/:id/void */
export interface VoidInvoiceRequest {
  reason?: string;
}
export interface VoidInvoiceResponse { invoice: Invoice; }

// Re-export the status enum from domain for callers that import from
// this module exclusively.
export type { InvoiceStatus };

// ── Errors (shared envelope) ────────────────────────────────────────────

export interface ApiErrorResponse {
  error: string;
  reason?: string;
  detail?: string;
  errors?: string[];
}
