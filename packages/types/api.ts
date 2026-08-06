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

import type {
  Accessorial, Asset, CheckCall, Customer, CustomerContact, Dispatcher, Driver,
  FuelReport, FuelReportMatchStatus,
  FuelTransaction, FuelTransactionMatchStatus, FuelTransactionProvider,
  InternalNote, Invoice, InvoiceLineItem, InvoiceStatus, Load, LoadAuditEntry,
  MaintenanceReport, MaintenanceReportStatus, MaintenanceReportPhoto,
  MaintenanceActionItem, MaintenanceActionItemPhoto, MaintenanceCategory, MaintenancePriority, MaintenanceActionStatus,
  OrgSettings, PayrollAdjustment, PayrollRecord, RefNum, SavedLocation, Stop, Trailer,
  DriverScore,
} from "./domain";
import type { CheckCallChannel, CheckCallParty, LoadStatus, RelayRole, TrailerCategory } from "./enums";

/** Billing-status enum used by /v1/closeout + /v1/reports. Mirrors
 *  the union on Load.billingStatus in domain.ts. */
export type BillingStatus = "pending" | "verified" | "invoiced" | "paid" | "on_hold";

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
 * For a relay load, send one entry per leg in leg order — the server
 * assigns leg_index from array position and derives relay_role
 * (first='pickup', last='delivery', middle='transfer'). An explicit
 * `relayRole` is accepted for back-compat but position wins.
 */
export interface CreateLoadRequestEvent {
  title: string;
  start: string;                // YYYY-MM-DDTHH:mm
  end: string;
  assetId: number;              // FK → assets
  driverId?: number;
  driverName?: string;
  status?: LoadStatus;          // defaults to 'scheduled'
  relayRole?: RelayRole;        // legacy hint; derived from position when multi-leg
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
  events: CreateLoadRequestEvent[]; // 1..N entries, in leg order
}

/**
 * Response: the joined view, one Load entry per event. Single-event load
 * returns one entry; an N-leg relay returns N entries (in leg order) all
 * sharing the same loadId and internalLoadId.
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
  /**
   * APPEND these entries to loads.audit_log, server-side.
   *
   * Prefer this over `auditLog` for anything that isn't EventModal.
   * `auditLog` is a full-array replacement, and the list endpoints do
   * NOT return events/loads audit_log on the joined Load — so a caller
   * working from a list read holds `auditLog: undefined`, and
   * "fetch, append, send" silently becomes "replace the entire history
   * with one entry". Appending server-side also runs the existing
   * dedup window and can't lose a concurrent writer's entry.
   *
   * Does not suppress the endpoint's own accessorial-diff append the
   * way `auditLog` does — the two cover different fields.
   */
  auditAppend?:    LoadAuditEntry[];
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
  /** Payroll defer marker — YYYY-MM-DD (Saturday weekStart) of the
   *  week this load's pay should land in. null clears the defer. */
  deferredToWeek?: string | null;
}

export interface UpdateEventResponse {
  loads: Load[];
}

// ── POST /v1/loads/:id/split-relay ──────────────────────────────────────

/**
 * Split ONE leg of a load into two, adding a handoff (N legs → N+1).
 *
 * `targetEventId` names the leg being split (optional — defaults to the
 * load's only event, preserving the original single→relay behavior).
 * The target leg keeps its position, gets its end clamped to `pickupEnd`,
 * and a new leg is inserted immediately after it with the supplied
 * scheduling + driver/asset assignment. leg_index is renumbered 0..N and
 * relay_role re-derived (first='pickup', last='delivery', middle=
 * 'transfer') across all legs. `mergedStops` is the full ordered stop
 * list including the new relay handoff stop; every leg stores the full
 * list, with per-leg windows derived from the relay markers.
 *
 * Field names keep their historical pickup/delivery spelling for wire
 * compat: "pickup*" = the leg being split, "delivery*" = the new leg.
 */
export interface SplitRelayRequest {
  pickupEnd:           string;        // YYYY-MM-DDTHH:mm — new end of the split leg
  deliveryStart:       string;        // start of the inserted leg
  deliveryEnd:         string;
  deliveryAssetId:     number;
  deliveryDriverId?:   number | null;
  deliveryDriverName?: string | null;
  /** Full ordered stop list after the split. */
  mergedStops:         Stop[];
  /** Index of the new relay handoff stop within mergedStops. */
  relayStopIndex:      number;
  /** Leg to split. Optional for back-compat; required when the load
   *  already has more than one leg. */
  targetEventId?:      string;
}

export interface SplitRelayResponse {
  loads: Load[]; // all legs of the load, in leg order
}

// ── POST /v1/loads/:id/unsplit-relay ────────────────────────────────────

/**
 * Inverse of split-relay: merge two ADJACENT legs into one (N → N-1).
 *
 * `keepEventId` names the surviving leg. `mergeEventId` names the
 * adjacent leg to absorb; optional when the load has exactly two legs
 * (the other leg is implied — the original unsplit behavior). The kept
 * event's window extends to cover both legs, the absorbed event is
 * soft-deleted, leg_index is renumbered and relay_role re-derived; on a
 * 2-leg load this clears relay_role entirely. If `mergedStops` is
 * supplied the kept event's stops are replaced with that list (sequence
 * rewritten 1..N); otherwise stops are kept as-is minus the collapsed
 * handoff marker.
 */
export interface UnsplitRelayRequest {
  keepEventId: string;
  /** Adjacent leg to merge into keepEventId. Required for 3+ legs. */
  mergeEventId?: string;
  mergedStops?: Stop[];
}

export interface UnsplitRelayResponse {
  loads: Load[]; // remaining legs of the load, in leg order
}

// ── PUT /v1/loads/:id/legs ──────────────────────────────────────────────

/**
 * Reconcile a load's legs to a desired configuration in ONE call.
 *
 * split-relay / unsplit-relay each change the leg count by one, which
 * forces a save-per-handoff when a dispatcher is authoring a multi-leg
 * relay ("Vegas → Hurricane → yard → SLC"). This endpoint takes the
 * whole intended shape — the full ordered stop list (with handoff
 * boundaries flagged) plus one entry per leg — and reconciles:
 *
 *   - legs carrying an `eventId` are updated in place,
 *   - legs without one are created,
 *   - existing legs absent from the list are soft-deleted,
 *   - leg_index / relay_role are renumbered from array position,
 *   - the full stop list is written to every leg.
 *
 * `legs.length` must equal (number of handoff stops) + 1 — legs are the
 * gaps between boundaries, so the two can't disagree.
 */
export interface ConfigureLegsRequestLeg {
  /** Existing event to reuse for this position. Omit to create a leg. */
  eventId?:    string;
  assetId:     number;
  driverId?:   number | null;
  driverName?: string | null;
  driverPay?:  number | null;
  start:       string;        // YYYY-MM-DDTHH:mm
  end:         string;
  status?:     LoadStatus;
  trailerId?:  number | null;
  trailerType?: string | null;
}

export interface ConfigureLegsRequest {
  /** Full ordered stop list for the load. Handoff boundaries are the
   *  stops with `isHandoff` set (or `type:'relay'`). */
  stops: Stop[];
  /** One entry per leg, in leg order. */
  legs:  ConfigureLegsRequestLeg[];
  /**
   * The load's overall window — when the freight is picked up and when
   * it is delivered. Legs TILE this window: the server pins the first
   * leg's start and the last leg's end to it, so adding or removing a
   * handoff can only subdivide the interior and can never move the
   * load's pickup or delivery.
   *
   * Omit to preserve the load's CURRENT window (earliest start / latest
   * end across its active legs), which is what adding or removing a
   * handoff should always do. Send it only when the dispatcher is
   * deliberately changing when the load runs.
   */
  loadWindow?: { start: string; end: string };
  /** @deprecated Accepted and ignored. The server no longer refuses to
   *  remove a leg that has progressed or holds documents: the
   *  dispatcher confirms by pressing Save on a UI that already shows
   *  the legs, a removed leg's pay goes with the leg by intent, and its
   *  documents are re-pointed to a surviving leg so paperwork always
   *  stays with the load. The old refusal also let stale client state
   *  dead-end a save with no way to clear it. */
  force?: boolean;
  /** @deprecated Accepted and ignored. This once hard-rejected a payload
   *  whose leg set had drifted, which dead-ended any client with a stale
   *  cache — it resent the same wrong set forever. Reconciling is
   *  convergent (the stop list is the truth, legs are made to match), so
   *  drift is converged rather than refused, and duplicate submits are
   *  prevented by the reuse pool instead. */
  expectedEventIds?: string[];
}

export interface ConfigureLegsResponse {
  loads: Load[]; // all legs of the load, in leg order
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
  /** Dispatcher-set street address for a relay trailer drop. Only
   *  meaningful on relay_role='pickup' events. The matching lat/lng
   *  pin is captured by the driver on the mobile app and stored in
   *  separate columns. */
  trailerDropoffAddress?: string | null;
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

// ── /v1/notifications ────────────────────────────────────────────────────

/**
 * Org-scoped recent-notifications log. Returns every load_notifications
 * row within the requested time window (default 48h), newest first.
 * Powers the dispatcher notifications bell in the calendar header so
 * pending nudges are visible at a glance and scheduled-push activity
 * can be audited without diving into individual loads.
 */
export interface ListOrgNotificationsResponse {
  notifications: import("./domain").LoadNotification[];
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
 *   driver_sheet — driver / trip sheet (load summary handed to the driver)
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
  /** Bare invoice PDF — just the invoice page, no rate-con / POD / etc.
   *  Used when the dispatcher needs to send "just the invoice" without
   *  the supporting docs that normally make up the packet. */
  | "invoice"
  /** Full broker-facing packet — invoice + rate-con + selected proof
   *  docs (POD/BOL/lumper/scale/etc) merged into one PDF. This is
   *  what gets emailed to the broker's AP team by default. */
  | "invoice_packet"
  | "relay_handoff"
  | "other";

/** Canonical ordered list — drives the UI chip order and validation. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "rate_con", "pod", "bol", "scale", "lumper", "receipt", "driver_sheet", "invoice", "invoice_packet", "relay_handoff", "other",
];

/** Legacy default allow-list, retained as a fallback for the small
 *  number of code paths still reading OrgSettings.driverVisibleDocKinds.
 *  New code should read OrgSettings.documentTypes via the helpers below. */
export const DEFAULT_DRIVER_VISIBLE_DOC_KINDS: readonly DocumentKind[] = [
  "pod", "bol", "scale", "lumper", "receipt", "driver_sheet", "relay_handoff", "other",
];

/** Kinds whose driverVisible flag is hard-locked to false. Server
 *  rejects PATCH /v1/org-settings attempts that try to set these
 *  visible. Used by the Settings UI to disable the toggle for these
 *  rows and explain why in a tooltip. */
export const DRIVER_HIDDEN_DOC_KINDS: readonly DocumentKind[] = [
  "rate_con", "invoice", "invoice_packet",
];

/** Default per-kind configuration for orgs that haven't set
 *  `documentTypes` yet (new orgs). Every kind enabled; rate_con and
 *  invoice locked off for drivers, everything else visible. The
 *  20260520 migration writes this same shape into every existing org
 *  so the server fallback only kicks in for brand-new orgs. */
export const DEFAULT_DOCUMENT_TYPES: readonly import("./domain").DocumentTypeConfig[] =
  DOCUMENT_KINDS.map((kind) => ({
    kind,
    enabled:       true,
    driverVisible: !DRIVER_HIDDEN_DOC_KINDS.includes(kind),
  }));

// ── Helpers ──────────────────────────────────────────────────────────
// Centralized lookups so every reader (web, driver, API) gets identical
// semantics. All three accept the OrgSettings.documentTypes field
// (possibly null/undefined for brand-new orgs) and fall through to
// DEFAULT_DOCUMENT_TYPES.

function resolveTypes(
  types: import("./domain").DocumentTypeConfig[] | null | undefined,
): readonly import("./domain").DocumentTypeConfig[] {
  // If the entire config is missing, the org has never customized
  // — use the canonical defaults.
  if (!types) return DEFAULT_DOCUMENT_TYPES;
  // Otherwise merge stored rows over per-kind defaults. The dispatcher
  // Settings → Documents panel applies the same defaulting logic when
  // rendering (line 1180-1182 in apps/web/app/settings/page.tsx) —
  // without it here, the panel and the API silently disagree: the
  // panel shows POD/BOL as enabled+visible (defaulting because they
  // aren't in the stored array), while the API thinks they don't
  // exist and excludes them from upload pickers + driver reads. That
  // asymmetry was the cause of the "POD uploads land as 'other' / I
  // can't see PODs in the driver app" bug — orgs whose stored
  // document_types was sparse (only had rate_con or a couple of kinds)
  // looked correct in the panel but were effectively missing every
  // other kind on the server.
  return DOCUMENT_KINDS.map((kind) => {
    const stored = types.find((t) => t.kind === kind);
    if (stored) return stored;
    return {
      kind,
      enabled:       true,
      driverVisible: !(DRIVER_HIDDEN_DOC_KINDS as readonly string[]).includes(kind),
    };
  });
}

/** Kinds visible in upload pickers across the whole product. */
export function enabledDocumentKinds(
  types: import("./domain").DocumentTypeConfig[] | null | undefined,
): DocumentKind[] {
  return resolveTypes(types)
    .filter((t) => t.enabled)
    .map((t) => t.kind as DocumentKind);
}

/** Kinds the driver app may show + accept on upload. Honors both
 *  flags: a kind must be enabled AND driverVisible. */
export function driverVisibleDocumentKinds(
  types: import("./domain").DocumentTypeConfig[] | null | undefined,
): DocumentKind[] {
  return resolveTypes(types)
    .filter((t) => t.enabled && t.driverVisible)
    .map((t) => t.kind as DocumentKind);
}

/** True iff the kind is dispatcher-only by hard policy (driver
 *  visibility cannot be toggled true). */
export function isDriverHiddenDocKind(kind: string): boolean {
  return (DRIVER_HIDDEN_DOC_KINDS as readonly string[]).includes(kind);
}

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
  /** Per-doc invoice-include flag.
   *  null = not explicitly set yet (client falls back to the
   *    PODs-near-delivery auto-include heuristic).
   *  true / false = explicit user choice (overrides the heuristic).
   *  Replaces the legacy loads.invoice_doc_ids array column — see
   *  the 20260607_load_documents_included_in_invoice migration. */
  includedInInvoice?: boolean | null;
  /** Internal storage_path on Supabase. Surfaced so the client can
   *  compare against loads.rate_con_pdf to identify which kind='rate_con'
   *  row is currently the load's primary — uploadedAt alone isn't
   *  enough since the dispatcher can promote an older rate-con via
   *  the Make Primary button. Not a security concern; signed URLs
   *  already encode the same path. */
  storagePath?: string;
  /** relay_handoff docs: 0-based ordinal of the handoff this photo
   *  belongs to (marker i sits between leg i and leg i+1). null/absent =
   *  legacy load-level photo — clients show it on every handoff. */
  handoffIndex?: number | null;
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
  /** Legacy free-text Make/Model field; prefer `make` + `model`. */
  truck?:           string | null;
  make?:              string | null;
  model?:             string | null;
  vin?:               string | null;
  licensePlate?:      string | null;
  licenseState?:      string | null;
  licenseExpiration?: string | null;
  notes?:             string | null;
  hidden?:            boolean;
  /** When true, withhold this truck from all report rollups (dashboard
   *  KPIs, per-truck charts, loads report) regardless of driver. Distinct
   *  from `hidden`. Mirrors drivers.exclude_from_reports. */
  excludeFromReports?: boolean;
  motiveVehicleId?:   string | null;
  /** Last 4 of the Mudflap fuel card assigned to this truck. */
  mudflapCardLast4?:  string | null;
  /** Optional explicit sort_order; otherwise the server appends to the end. */
  sortOrder?:         number;
  /** YYYY-MM-DD; defaults to today server-side. */
  activeFrom?:        string;
  /** YYYY-MM-DD or null. null = currently active (the default). */
  activeTo?:          string | null;
}
export interface CreateAssetResponse { asset: Asset; }
export interface UpdateAssetRequest  {
  name?:              string;
  color?:             string;
  type?:              string;
  unit?:              string | null;
  /** Legacy free-text Make/Model field; prefer `make` + `model`. */
  truck?:             string | null;
  make?:              string | null;
  model?:             string | null;
  vin?:               string | null;
  licensePlate?:      string | null;
  licenseState?:      string | null;
  licenseExpiration?: string | null;
  notes?:             string | null;
  hidden?:          boolean;
  /** Withhold this truck from all report rollups regardless of driver.
   *  Distinct from `hidden`. Mirrors drivers.exclude_from_reports. */
  excludeFromReports?: boolean;
  motiveVehicleId?: string | null;
  /** Last 4 of the Mudflap fuel card assigned to this truck. */
  mudflapCardLast4?: string | null;
  sortOrder?:       number;
  /** Move the start of active period (rare — usually set once on create). */
  activeFrom?:      string;
  /** Stamp/clear the retire date. null = "currently active" (unretire). */
  activeTo?:        string | null;
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
  /** YYYY-MM-DD; defaults to today server-side. */
  activeFrom?: string;
  /** YYYY-MM-DD or null. null = currently active. */
  activeTo?:   string | null;
}
export interface CreateDriverResponse { driver: Driver; }
export interface UpdateDriverRequest {
  name?:           string;
  firstName?:      string | null;
  lastName?:       string | null;
  phone?:          string | null;
  notes?:          string | null;
  email?:          string | null;
  address?:        string | null;
  licenseNumber?:  string | null;
  licenseState?:   string | null;
  licenseExp?:     string | null;
  medicalCardExp?: string | null;
  dob?:            string | null;
  activeFrom?:     string;
  /** Stamp/clear the retire date. null = currently active (unretire). */
  activeTo?:       string | null;
  /** Owner-operator flag. See Driver.excludeFromReports for semantics. */
  excludeFromReports?: boolean;
}
export interface UpdateDriverResponse { driver: Driver; }

// ── /v1/drivers/:id/documents + /v1/driver/documents ─────────────────────

export interface ListDriverDocumentsResponse {
  documents: import("./domain").DriverDocument[];
}
export interface CreateDriverDocumentResponse {
  document: import("./domain").DriverDocument;
}
export interface GetDriverDocumentUrlResponse {
  url: string;
}

// ── /v1/assets/:id/documents + /v1/asset-documents ───────────────────────

export interface ListAssetDocumentsResponse {
  documents: import("./domain").AssetDocument[];
}
export interface CreateAssetDocumentResponse {
  document: import("./domain").AssetDocument;
}
export interface GetAssetDocumentUrlResponse {
  url: string;
}

// ── /v1/trailers/:id/documents + /v1/trailer-documents ───────────────────

export interface ListTrailerDocumentsResponse {
  documents: import("./domain").TrailerDocument[];
}
export interface CreateTrailerDocumentResponse {
  document: import("./domain").TrailerDocument;
}
export interface GetTrailerDocumentUrlResponse {
  url: string;
}

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
  contacts?:            CustomerContact[];
  notes?:               string | null;
  parseHints?:          string | null;
  invoiceMethod?:       'email' | 'portal' | null;
  invoiceEmail?:        string | null;
  invoicePortal?:       string | null;
  invoiceInstructions?: string | null;
  billingAddress?:      string | null;
  /** When a customer with the same (case-insensitive) name already
   *  exists in the org, POST /v1/customers rejects with 409
   *  `duplicate_name` UNLESS this is true — i.e. the dispatcher saw the
   *  "already exists" prompt and chose to create a separate record
   *  anyway. */
  force?:               boolean;
}
export interface CreateCustomerResponse { customer: Customer; }

/** 409 body from POST /v1/customers when a same-name customer already
 *  exists and `force` was not set. Lists the colliding record(s) so the
 *  client can name them in the confirm prompt. */
export interface DuplicateCustomerResponse {
  error:    'duplicate_name';
  existing: Customer[];
}

/** Body from DELETE /v1/customers/:id. The customer row is removed and
 *  every load/invoice FK is nulled (ON DELETE SET NULL); loads keep the
 *  readable broker name. `keptNameOnLoads` counts loads that had the
 *  name backfilled because their denormalized `broker` field was empty. */
export interface DeleteCustomerResponse {
  deleted:         true;
  id:              string;
  keptNameOnLoads: number;
}

/** POST /v1/customers/:id/merge — fold the customer in the URL (source)
 *  into `targetId` (kept), reassigning every load + invoice, then delete
 *  the source. The source's name/aliases are added to the target's
 *  alias list so rate-con matching still recognizes the old name. */
export interface MergeCustomerRequest  { targetId: string; }
export interface MergeCustomerResponse {
  merged:        true;
  sourceId:      string;
  targetId:      string;
  movedLoads:    number;
  movedInvoices: number;
}
export interface UpdateCustomerRequest {
  name?:                string;
  shortName?:           string | null;
  aliases?:             string[];
  mcNum?:               string | null;
  contactName?:         string | null;
  contactEmail?:        string | null;
  contactPhone?:        string | null;
  contacts?:            CustomerContact[];
  notes?:               string | null;
  parseHints?:          string | null;
  invoiceMethod?:       'email' | 'portal' | null;
  invoiceEmail?:        string | null;
  invoicePortal?:       string | null;
  invoiceInstructions?: string | null;
  billingAddress?:      string | null;
}
export interface UpdateCustomerResponse { customer: Customer; }

// ── POST /v1/customers/:id/refresh-invoicing-from-ratecon ───────────────
//
// Re-runs the rate-con pass-1 broker-harvest prompt against the most
// recent load on file for this customer and returns the extracted
// invoicing fields. The endpoint does NOT auto-write to the customer —
// the UI pre-fills the BrokerProfileModal form so the user can review
// and Save (the existing PATCH /v1/customers/:id flow commits).
//
// `parsed` is undefined when the customer has no loads with a rate
// con yet (404 instead). All four parsed fields are optional because
// Claude returns empty strings for unknown values; the UI surfaces
// "(no value)" rather than blanking what's already saved.

// ── POST /v1/customers/harvest-from-pdf ────────────────────────────────
//
// Run the broker-harvest prompt against a PDF supplied in the body,
// without needing a saved customer or load. Used by the new-customer
// review modal to pre-fill contact + invoicing fields directly from
// the rate con the user just uploaded.

export interface HarvestRateConFromPdfRequest {
  /** Base64-encoded PDF bytes (no data: prefix). */
  pdfBase64: string;
}

export interface HarvestRateConFromPdfResponse {
  parsed: {
    invoiceMethod?:       string;
    invoiceEmail?:        string;
    invoicePortal?:       string;
    invoiceInstructions?: string;
    contactName?:         string;
    contactEmail?:        string;
    contactPhone?:        string;
    billingAddress?:      string;
  };
  parsedAt: string;
}

export interface RefreshCustomerInvoicingResponse {
  parsed: {
    invoiceMethod?:       string;
    invoiceEmail?:        string;
    invoicePortal?:       string;
    invoiceInstructions?: string;
    billingAddress?:      string;
  };
  /** Load whose rate con was used (newest with a non-null rate_con_pdf). */
  sourceLoadId:    string;
  sourceLoadNum?:  string;
  /** ISO 8601 timestamp the parse ran. */
  parsedAt:        string;
}

// ── /v1/trailers ─────────────────────────────────────────────────────────

export interface ListTrailersResponse { trailers: Trailer[]; }
export interface CreateTrailerRequest {
  name:               string;
  trailerNumber?:     string | null;
  category:           TrailerCategory;
  notes?:             string | null;
  motiveVehicleId?:   string | null;
  make?:              string | null;
  model?:             string | null;
  vin?:               string | null;
  licensePlate?:      string | null;
  licenseState?:      string | null;
  licenseExpiration?: string | null;
  /** YYYY-MM-DD; defaults to today server-side. */
  activeFrom?:        string;
  /** YYYY-MM-DD or null. null = currently active. */
  activeTo?:          string | null;
}
export interface CreateTrailerResponse { trailer: Trailer; }
export interface UpdateTrailerRequest {
  name?:              string;
  trailerNumber?:     string | null;
  category?:          TrailerCategory;
  notes?:             string | null;
  motiveVehicleId?:   string | null;
  make?:              string | null;
  model?:             string | null;
  vin?:               string | null;
  licensePlate?:      string | null;
  licenseState?:      string | null;
  licenseExpiration?: string | null;
  activeFrom?:        string;
  /** Stamp/clear the retire date. null = currently active (unretire). */
  activeTo?:          string | null;
}
export interface UpdateTrailerResponse { trailer: Trailer; }

// ── /v1/dispatchers ──────────────────────────────────────────────────────

export interface ListDispatchersResponse { dispatchers: Dispatcher[]; }
export interface CreateDispatcherRequest {
  firstName:   string;
  lastName:    string;
  hireDate?:   string;   // YYYY-MM-DD
  clerkUserId?: string;
  isDefault?:  boolean;
  active?:     boolean;
}
export interface CreateDispatcherResponse { dispatcher: Dispatcher; }
export interface UpdateDispatcherRequest {
  firstName?:   string;
  lastName?:    string;
  /** Pass null to clear an existing hire date; omit to leave it alone. */
  hireDate?:    string | null;
  /** Pass null to clear an existing Clerk link. */
  clerkUserId?: string | null;
  isDefault?:   boolean;
  active?:      boolean;
}
export interface UpdateDispatcherResponse { dispatcher: Dispatcher; }

// ── /v1/driver-asset-prefs ───────────────────────────────────────────────
//
// Asset → preferred driver mapping (one preferred driver per asset).
// Stored in the driver_asset_prefs table; PK is asset_id.

export interface DriverAssetPref {
  assetId: number;
  /** Primary driver — the one whose truck this is. Auto-fills when
   *  the asset is selected on a load. */
  driverId: number | null;
  /** Optional secondary driver — typically a fill-in who doesn't
   *  have their own truck and uses this one when they work. Picking
   *  this driver auto-fills the same asset as the primary would. */
  secondaryDriverId?: number | null;
}
export interface ListDriverAssetPrefsResponse { prefs: DriverAssetPref[]; }
/** PUT body — either field may be null to clear that slot, or omitted
 *  to leave it unchanged. If both end up null on the server, the row
 *  is deleted entirely. */
export interface SetDriverAssetPrefRequest {
  driverId?: number | null;
  secondaryDriverId?: number | null;
}
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
  /** Optional back-reference to the inspection report that triggered this
   *  adjustment (cleanliness deduction). */
  inspectionReportId?: string | null;
}
/** Adjustment writes are ACCEPTED even when the target week is already
 *  finalized — see apps/api/src/routes/payroll.ts for the reasoning —
 *  but the caller is told, so the UI can surface the divergence instead
 *  of pretending the finalized stub moved. `finalizedRecordId` is the
 *  live record for that (driver, week). */
export interface PayrollWeekFinalizedFlag {
  weekFinalized?:     boolean;
  finalizedRecordId?: string;
  finalizedTotalPay?: number;
}
export interface CreatePayrollAdjustmentResponse extends PayrollWeekFinalizedFlag {
  adjustment: PayrollAdjustment;
}
export type DeletePayrollAdjustmentResponse = PayrollWeekFinalizedFlag;

// ── Driver scoring ────────────────────────────────────────────────────────
// GET /v1/driver-scoring?from=YYYY-MM-DD&to=YYYY-MM-DD  (Curzon-only)
export interface ListDriverScoresResponse {
  from: string;
  to: string;
  scores: DriverScore[];
  /** The transparent weights used to compute `score`, echoed so the UI can
   *  show how a number was reached. */
  weights: { bonusThreshold: number };
}

// GET /v1/driver/scorecard — the signed-in driver's own inspection score for
// the current month. Same math as the dispatcher scorecard, scoped to them.
// `enabled` is false when the org lacks the Truck History module, so the app
// simply doesn't render the card.
export interface DriverScorecardResponse {
  enabled: boolean;
  from: string;
  to: string;
  activeDays: number;
  inspectionDays: number;
  preTrips: number;
  postTrips: number;
  completionPct: number;
  score: number;
  bonusEligible: boolean;
  bonusThreshold: number;
}

// Query params:
//   driverName  — required when listing
//   weekStart?  — filter to a single week
//   includeSuperseded=1 — also return records that were reopened or
//     replaced by a re-finalize. OFF by default: every summing caller
//     (dashboard KPI, pay history) would double-count them.
export interface ListPayrollRecordsResponse { records: PayrollRecord[]; }
export interface UpsertPayrollRecordRequest {
  driverName: string;
  weekStart:  string;
  totalPay:   number;
  notes?:     string | null;
  /** The frozen detail behind `totalPay`. Omitting it still records a
   *  total, but the resulting record can't reprint the stub it paid for —
   *  clients that can build the lines should always send them. */
  lineItems?: import("./domain").PayrollLineItem[] | null;
  /** Display label for whoever pressed Finalize. The Clerk user id comes
   *  from the JWT server-side; this is only for rendering. */
  finalizedByName?: string | null;
}
export interface UpsertPayrollRecordResponse {
  record: PayrollRecord;
  /** The record this one replaced, if the week was already finalized.
   *  It still exists (superseded, not deleted). */
  supersededRecord?: PayrollRecord;
}
/** Reopen. The record is superseded, never deleted — the amount that was
 *  signed off on, and who signed it, stay queryable forever. */
export interface DeletePayrollRecordResponse { record: PayrollRecord; }

/** POST /v1/payroll/records/:id/send — sends the paystub link to the
 *  driver via SMS + push. No body required (the frozen record IS the
 *  payload). The record must be active (not superseded); the driver
 *  must exist in `drivers` and have a phone number for SMS to fire.
 *  Push fires whenever a device token is registered for the driver
 *  regardless of SMS state. */
export interface SendPaystubResponse {
  record: PayrollRecord;
  /** Per-channel outcome for THIS send attempt. Absent fields ran
   *  and succeeded silently; a present `error` means the channel
   *  didn't deliver (but the send itself is still considered
   *  successful as long as at least one channel worked). */
  smsResult:  { ok: true; sid: string } | { ok: false; error: string };
  pushResult: { ok: true } | { ok: false; error: string };
}

// ── /v1/org-settings ────────────────────────────────────────────────────

export interface GetOrgSettingsResponse { settings: OrgSettings; }
export interface UpdateOrgSettingsRequest {
  showDriverPay?:    boolean;
  rateConSettings?:  import("./domain").RateConSettings | null;
  invoiceSettings?:  import("./domain").InvoiceSettings | null;
  /** Replaces the entire role-overrides map. Use {} to clear all
   *  overrides; omit to leave unchanged. */
  roleOverrides?:    import("./domain").RoleOverrides;
  /** Replaces the entire org-modules flags map. Use {} to reset to
   *  defaults (all-enabled); omit to leave unchanged. */
  orgModules?:       import("./domain").OrgModuleFlags;
  /** Legacy — superseded by `documentTypes`. Replaces the driver-
   *  visible-doc-kinds allow-list. Still accepted for one release so
   *  older clients keep working; the server upserts the equivalent
   *  rows into `documentTypes` when this is sent. */
  driverVisibleDocKinds?: string[] | null;
  /** Replace the per-org document-type configuration. Send the full
   *  array (no partial updates). Server validates:
   *    - every entry's `kind` is in DOCUMENT_KINDS
   *    - rate_con / invoice have driverVisible: false (rejects 400 otherwise)
   *    - no duplicate kinds
   *  Send null to reset to DEFAULT_DOCUMENT_TYPES; omit to leave unchanged. */
  documentTypes?: import("./domain").DocumentTypeConfig[] | null;
  /** Replaces the per-org notification rules. Full-object replace
   *  (the UI ships the whole shape on save). Omit to leave unchanged.
   *  null clears back to the server default. */
  notificationRules?: import("./notifications").NotificationRules | null;
  /** Motive integration config — sync toggles + cadences. Merged
   *  shallowly with the existing row so a single-field PATCH works. */
  motiveSettings?:   import("./domain").MotiveSettings | null;
  /** Replace the list of document kinds auto-included in invoice packets
   *  (e.g. ["pod","bol"]). Full replace — send the whole array. [] =
   *  auto-include nothing; null = reset to the POD default. Server
   *  validates every entry is a packet doc kind. */
  invoiceAutoIncludeKinds?: string[] | null;
}
export interface UpdateOrgSettingsResponse { settings: OrgSettings; }

// ── /v1/driver/notification-prefs ──────────────────────────────────────
//
// Per-driver overrides for org-level notification rules. Sparse: a
// missing key means "follow org default". Driver-app only — manager
// surfaces sit on /v1/drivers/:id/notification-prefs (not yet built).

export interface GetDriverNotificationPrefsResponse {
  /** Map of rule key → enabled flag. Sparse — only rules the driver
   *  has explicitly overridden are present. */
  prefs: Record<string, boolean>;
}
export interface UpdateDriverNotificationPrefRequest {
  /** Which rule to override. See NotificationRuleKey. */
  ruleKey: string;
  /** Set to follow the org default by passing null. */
  enabled: boolean | null;
}
export interface UpdateDriverNotificationPrefResponse {
  prefs: Record<string, boolean>;
}

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
  /** Reassign / set the broker (customer FK) on a draft invoice. Used
   *  to fix invoices generated from loads whose customer wasn't yet
   *  matched. The API resolves the picked customer and refreshes the
   *  snapshot's broker fields (name, MC#, AR email) at the same time
   *  so the printed invoice and the email recipient stay in sync. */
  customerId?:          string | null;
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
  /** Permission to send the packet even when one or more of the
   *  dispatcher-selected supporting docs failed to download or embed.
   *  Default false: the API returns 422 `packet_incomplete` listing
   *  the failed paths so the dispatcher knows the email did NOT go
   *  out and can fix the docs (re-upload, convert HEIC → JPG, etc.).
   *  Set true to acknowledge the loss and ship anyway. */
  allowPartialPacket?: boolean;
}

export interface SendInvoiceResponse { invoice: Invoice; }

/**
 * Build the merged invoice PDF packet (invoice + rate con + load
 * docs) and persist it to load_documents. This is the "Generate"
 * action — runs independently of /send so the user can review the
 * packet before emailing the broker. The /send endpoint always
 * rebuilds fresh at send-time, so editing an invoice between
 * Generate and Send is safe (the email reflects current state).
 */
export interface GenerateInvoicePacketResponse {
  /** load_documents row id for the freshly persisted packet. */
  documentId:  string;
  /** Storage path inside the load-documents bucket. */
  storagePath: string;
  /** 1-hour signed URL the client can use to download / preview the
   *  packet without round-tripping through the API. */
  signedUrl:   string;
}

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
  /** Same semantics as SendInvoiceRequest.allowPartialPacket. Defaults
   *  to false: any invoice whose packet drops a selected doc gets
   *  reported as `failed` in the per-invoice results and stays in
   *  draft so the dispatcher can fix + retry. Set true to ship every
   *  packet despite drops. */
  allowPartialPacket?: boolean;
}

export interface BatchSendInvoicesResponse {
  /** Per-invoice group results, in arbitrary order. (Despite the name,
   *  the send loop is per-invoice now — each entry's invoiceIds is
   *  length 1. The shape is kept for backwards compat.) */
  groups: Array<{
    /** May be empty when the invoice was created without a customer
     *  link (legacy / hand-entered loads). The corresponding status is
     *  'skipped_no_customer'. */
    customerId:  string;
    brokerName:  string;
    to:          string | null;
    /** 'sent'                 — invoice email delivered to the broker.
     *  'sent_portal'          — broker is portal-mode; no email went
     *                            to the broker. The invoice is flipped
     *                            to sent (sent_method='portal',
     *                            sent_to=portal label) so it advances
     *                            through the pipeline. When bccSelf
     *                            was on, the dispatcher gets a copy of
     *                            the packet so they can upload to the
     *                            portal themselves.
     *  'skipped_no_email'     — broker exists, email-mode, but has no
     *                            AP email set.
     *  'skipped_no_customer'  — invoice has no customer link (can't
     *                            resolve a recipient at all).
     *  'failed'               — packet build or email send threw. */
    status:      'sent' | 'sent_portal' | 'skipped_no_email' | 'skipped_no_customer' | 'failed';
    invoiceIds:  string[];
    /** Internal load number for the (single) invoice in this group.
     *  Falls back to load_num (the broker's load #) when internal
     *  isn't set. Surfaced in the UI so a "Sent" row identifies
     *  exactly which load shipped. */
    loadNumber?: string;
    error?:      string;
    messageId?:  string;
  }>;
}

/**
 * POST /v1/invoices/batch-resend — resend already-sent invoices (one
 * email per invoice, same templated subject/body/packet).
 *
 *   - All invoice ids must reference SENT invoices. Drafts go through
 *     batch-send; mixed-status sets fail 400.
 *   - Behaviour mirrors batch-send: per-invoice email, broker recipient
 *     pulled from the invoice's customer_id, ccEmail merged from the
 *     org's invoice_settings.
 *   - sent_at is refreshed on each successful resend so audit logs show
 *     the latest send. Status stays 'sent' (it's already there).
 */
export interface BatchResendInvoicesRequest {
  invoiceIds: string[];
  cc?:        string[];
  bccSelf?:   boolean;
  bodyText?:  string;
  attachLoadDocs?: boolean;
}

/** Same shape as the send response — `groups[]` keyed by invoice with
 *  invoiceIds[].length === 1 per entry. */
export type BatchResendInvoicesResponse = BatchSendInvoicesResponse;

/** POST /v1/invoices/:id/mark-paid */
export interface MarkInvoicePaidRequest {
  paidAt?:  string;
  amount?:  number;
  method?:  'ach' | 'check' | 'wire' | 'other';
  note?:    string;
}
export interface MarkInvoicePaidResponse { invoice: Invoice; }

/** POST /v1/invoices/:id/unmark-paid — reverts paid → sent.
 *  Clears paid_at / paid_amount / paid_method / paid_note and rolls
 *  loads.billing_status back from 'paid' to 'invoiced'. Use for
 *  payment reversals or correcting a wrong mark-paid. */
export interface UnmarkInvoicePaidRequest {
  reason?: string;
}
export interface UnmarkInvoicePaidResponse { invoice: Invoice; }

/** POST /v1/invoices/:id/void */
export interface VoidInvoiceRequest {
  reason?: string;
}
export interface VoidInvoiceResponse { invoice: Invoice; }

// Re-export the status enum from domain for callers that import from
// this module exclusively.
export type { InvoiceStatus };

// ── /v1/payments — receivables: proofs + allocations ────────────────────
//
// Split across two resource families:
//   /v1/payments/proofs            — evidence CRUD + attachment upload
//   /v1/invoices/:id/payments      — allocate money to one invoice
//
// Every write that touches an allocation returns the affected invoice so
// the client can update its row without a refetch. invoices.paid_amount /
// paid_at / status are recomputed server-side from the allocation set on
// every such write — clients must never patch them directly.

import type {
  PaymentProof, PaymentProofKind, PaymentProofSource, PaymentMethod,
  PaymentVarianceReason, InvoicePayment, ReceivableInvoice,
  ReceivableCustomerSummary, AgingBucket, CustomerReceivables, WeeklyCollection,
} from './domain';

/** GET /v1/payments/proofs — filters are ANDed.
 *  `unapplied=true` returns only proofs whose allocations sum to less
 *  than the proof amount (including zero) — the review pile. */
export interface ListPaymentProofsQuery {
  customerId?: string;
  kind?:       PaymentProofKind;
  unapplied?:  boolean;
  from?:       string;   // YYYY-MM-DD, inclusive, on occurred_on
  to?:         string;
  limit?:      number;
}
export interface ListPaymentProofsResponse { proofs: PaymentProof[]; }

export interface GetPaymentProofResponse {
  proof:    PaymentProof;
  /** Allocations citing this proof, each expanded with its invoice
   *  number + total so the UI can render "what did this cover". */
  payments: (InvoicePayment & {
    invoiceNumber?: string;
    invoiceTotal?:  number;
  })[];
}

/** POST /v1/payments/proofs — record evidence. The file itself uploads
 *  separately via POST /v1/payments/proofs/:id/attachment (multipart), so
 *  a proof can be created from a bank line with nothing to attach. */
export interface CreatePaymentProofRequest {
  kind:        PaymentProofKind;
  source?:     PaymentProofSource;   // defaults to 'manual'
  customerId?: string;
  payerRaw?:   string;
  occurredOn:  string;               // YYYY-MM-DD
  amount:      number;
  reference?:  string;
  note?:       string;
  /** Required for source csv/email/api — the idempotency key. */
  externalId?: string;
}
export interface CreatePaymentProofResponse { proof: PaymentProof; }

// ── Parse an uploaded payment document ────────────────────────────────
// Proposal returned by POST /v1/payments/parse. Nothing is written; the
// operator reviews this and confirms, and the confirm path reuses the
// ordinary proof + allocation endpoints.

/** How confidently a line was tied to an invoice, and by which identifier.
 *  `ambiguous` means more than one invoice matched — never auto-applied. */
export type PaymentMatchedBy =
  | 'invoice_number' | 'load_num' | 'internal_load_id'
  | 'processor_ref'  | 'ambiguous' | 'none'
  /** Chosen by a person from the invoice search — the resolver found nothing
   *  or found the wrong thing, and a human said which invoice it is. */
  | 'manual';

/** A candidate returned by the invoice search, shaped so it can be shown
 *  the same way a matched line is. */
export interface InvoiceSearchResult {
  invoiceId:      string;
  invoiceNumber:  string;
  invoiceTotal:   number;
  invoicePaid:    number;
  invoiceStatus:  string;
  loadNum:        string | null;
  internalLoadId: string | null;
  title:          string | null;
  pickupAt:       string | null;
  customerName:   string | null;
  agingDays:      number | null;
}

export interface SearchInvoicesResponse { invoices: InvoiceSearchResult[]; }

export interface ParsedPaymentLine {
  rowIndex:           number;
  /** Verbatim from the document — not normalized. */
  referenceAsPrinted: string | null;
  amount:             number;
  deduction:          number | null;
  deductionLabel:     string | null;
  invoiceId:          string | null;
  invoiceNumber:      string | null;
  invoiceTotal:       number | null;
  invoicePaid:        number | null;
  invoiceStatus:      string | null;
  /** Invoice is already settled — re-applying would push it overpaid. */
  alreadyPaid:        boolean;
  invoiceCustomerId:  string | null;
  customerName:       string | null;
  loadNum:            string | null;
  internalLoadId:     string | null;
  /** Pickup leg title + date, so a line reads like the Receivables table. */
  title:              string | null;
  pickupAt:           string | null;
  issuedAt:           string | null;
  dueAt:              string | null;
  /** Days past due; negative or null means not yet due. */
  agingDays:          number | null;
  matchedBy:          PaymentMatchedBy;
  confidence:         number;
  /** Every form that was looked up, so the reviewer can see what was tried. */
  candidates:         string[];
  ambiguous:          string[] | null;
  note:               string | null;
}

/** An earlier proof carrying the same reference. Warned about, not blocked:
 *  applying half a remittance now and the rest once the missing loads are
 *  invoiced is legitimate, so the operator decides. */
export interface ParsePaymentDuplicate {
  proofId:      string;
  occurredOn:   string;
  amount:       number;
  reference:    string | null;
  createdAt:    string;
  /** Allocations already citing that proof. */
  appliedCount: number;
}

export interface ParsePaymentResponse {
  isRemittance: boolean;
  /** Why it was rejected, when isRemittance is false. */
  reason: string | null;
  duplicate: ParsePaymentDuplicate | null;
  doc: {
    source:             string;
    payerNameAsPrinted: string;
    paymentDate:        string;
    paymentTotal:       number;
    externalId:         string | null;
    unparsedRows:       string[];
  } | null;
  /** sum(lines) vs the total printed on the document. `ok: false` means a
   *  row was probably missed — the document must not be applied as-is. */
  totals: {
    ok: boolean; lineSum: number; declared: number; drift: number; reason?: string;
  } | null;
  /** Derived from the matched invoices, not the printed payer name — which
   *  is often a factoring company or a legal entity held under another name. */
  inferredCustomerId: string | null;
  lines: ParsedPaymentLine[];
  summary: {
    lineCount: number; matched: number; unmatched: number; autoApply: number;
    matchedAmount: number; totalAmount: number; alreadyPaid: number;
  } | null;
}

export interface UpdatePaymentProofRequest {
  kind?:       PaymentProofKind;
  customerId?: string | null;
  payerRaw?:   string | null;
  occurredOn?: string;
  amount?:     number;
  reference?:  string | null;
  note?:       string | null;
}
export interface UpdatePaymentProofResponse { proof: PaymentProof; }

/** DELETE /v1/payments/proofs/:id — removes the proof and its blob.
 *  Allocations citing it survive with proofId cleared: the money still
 *  moved, only the paperwork was wrong. `unlinkedPayments` reports how
 *  many allocations were left unbacked. */
export interface DeletePaymentProofResponse {
  ok: true;
  unlinkedPayments: number;
}

/** POST /v1/payments/proofs/:id/attachment — multipart, field `file`. */
export interface UploadProofAttachmentResponse { proof: PaymentProof; }

/** GET /v1/payments/proofs/:id/attachment — 302 to a signed URL. */

/** GET /v1/invoices/:id/payments */
export interface ListInvoicePaymentsResponse { payments: InvoicePayment[]; }

/** POST /v1/invoices/:id/payments — apply money to this invoice.
 *
 *  Omitting `amount` applies the invoice's full outstanding balance,
 *  which is the common case (broker paid exactly what was billed).
 *  Supplying a short amount without a `varianceReason` is accepted but
 *  the UI prompts for one — an unexplained short-pay is a collections
 *  problem, not a data-entry preference. */
export interface CreateInvoicePaymentRequest {
  amount?:         number;
  paidOn?:         string;           // defaults to today
  method?:         PaymentMethod;
  proofId?:        string;
  varianceReason?: PaymentVarianceReason;
  note?:           string;
}
export interface CreateInvoicePaymentResponse {
  payment: InvoicePayment;
  /** Recomputed — status may have flipped to paid. */
  invoice: Invoice;
}

export interface UpdateInvoicePaymentRequest {
  amount?:         number;
  paidOn?:         string;
  method?:         PaymentMethod | null;
  proofId?:        string | null;
  varianceReason?: PaymentVarianceReason | null;
  note?:           string | null;
}
export interface UpdateInvoicePaymentResponse {
  payment: InvoicePayment;
  invoice: Invoice;
}

/** DELETE /v1/invoices/:id/payments/:paymentId — reverse an allocation.
 *  Recomputes the invoice, which may drop it back out of `paid`. */
export interface DeleteInvoicePaymentResponse {
  ok: true;
  invoice: Invoice;
}

/** GET /v1/receivables — everything the Receivables page needs in one
 *  round trip: the invoice rows, the per-customer rail, and the summary
 *  tiles. Computed server-side so the aging math has exactly one
 *  implementation. */
export interface ListReceivablesQuery {
  customerId?: string;
  bucket?:     AgingBucket;
  /** 'open' (default) = sent/draft with a balance; 'paid' = fully
   *  settled; 'all' = both. Void is always excluded. */
  scope?:      'open' | 'paid' | 'all';
  search?:     string;   // invoice number / load number
  limit?:      number;
}
export interface ListReceivablesResponse {
  invoices:  ReceivableInvoice[];
  customers: ReceivableCustomerSummary[];
  totals:    ReceivablesTotals;
}

export interface ReceivablesTotals {
  openCount:       number;
  openBalance:     number;
  overdueCount:    number;
  overdueBalance:  number;
  /** Allocations dated within the trailing 30 days. */
  collected30d:    number;
  /** Open balance per aging bucket — drives the clickable tiles. */
  byBucket:        Record<AgingBucket, { count: number; balance: number }>;
  /** Invoices marked paid with no evidence attached anywhere. */
  unbackedPaidCount: number;
}

/** GET /v1/payments/receivables/:customerId — the customer view in one
 *  call. Pass the literal `__none__` for invoices with no customer set,
 *  matching the sentinel the ledger uses. */
export interface GetCustomerReceivablesQuery {
  scope?: 'open' | 'paid' | 'all';
}
export interface GetCustomerReceivablesResponse {
  customer: CustomerReceivables;
}

export type {
  PaymentProof, PaymentProofKind, PaymentProofSource, PaymentMethod,
  PaymentVarianceReason, InvoicePayment, ReceivableInvoice,
  ReceivableCustomerSummary, AgingBucket, CustomerReceivables, WeeklyCollection,
};

// ── /v1/driver/fuel-reports + /v1/fuel-reports ──────────────────────────
//
// Two surfaces share the same data shapes:
//   - /v1/driver/fuel-reports — auth via Supabase JWT, driver app only.
//     Scoped to the signed-in driver; the driverId on writes is forced
//     to match the auth context.
//   - /v1/fuel-reports        — auth via Clerk org session, dispatch /
//     accounting surfaces. Sees every report in the org.

/** POST /v1/driver/fuel-reports or /v1/fuel-reports — submit a fuel-up. */
export interface CreateFuelReportRequest {
  /** Required on the Clerk-auth path; ignored on /v1/driver where the
   *  driver is taken from the auth context. */
  driverId?:      number;
  assetId:        number;
  state:          string;        // 2-letter US abbreviation
  dieselGallons:  number;
  defGallons?:    number;
  odometer?:      number;
  /** ISO timestamp. Defaults to server-side `now()` when omitted. */
  reportedAt?:    string;
  latitude?:      number;
  longitude?:     number;
  notes?:         string;
}
export interface CreateFuelReportResponse { fuelReport: FuelReport; }

/** GET /v1/fuel-reports + /v1/driver/fuel-reports — list with filters.
 *  All filter params are optional; combining them ANDs them together. */
export interface ListFuelReportsQuery {
  /** Inclusive lower bound on reported_at (ISO). */
  from?:          string;
  /** Exclusive upper bound on reported_at (ISO). */
  to?:            string;
  driverId?:      number;
  assetId?:       number;
  matchStatus?:   FuelReportMatchStatus;
  /** Pagination. Defaults applied server-side. */
  limit?:         number;
  offset?:        number;
}
export interface ListFuelReportsResponse {
  fuelReports: FuelReport[];
  total:       number;
  limit:       number;
  offset:      number;
}

/** PATCH /v1/fuel-reports/:id — edit a report (correct a typo, fix a
 *  wrong asset selection, etc.). Driver edits go through the same
 *  endpoint via /v1/driver/fuel-reports/:id which restricts ownership. */
export interface UpdateFuelReportRequest {
  assetId?:       number;
  state?:         string;
  dieselGallons?: number;
  defGallons?:    number | null;
  odometer?:      number | null;
  reportedAt?:    string;
  notes?:         string | null;
  matchStatus?:   FuelReportMatchStatus;
}
export interface UpdateFuelReportResponse { fuelReport: FuelReport; }

// ── /v1/fuel-transactions ───────────────────────────────────────────────
//
// Card-side fuel transactions ingested from the fleet card provider.
// See FuelTransaction in domain.ts for field semantics.

/** POST /v1/fuel-transactions/inbound-email — Google Apps Script
 *  forwards a raw Mudflap email here. Auth: X-Api-Key header. The
 *  API parses the email, inserts a fuel_transactions row, and runs
 *  the auto-matcher. Idempotent on (provider, providerTransactionId). */
export interface InboundFuelEmailRequest {
  /** Full raw MIME content of the email. */
  raw:     string;
  /** Optional base64-encoded PDF attachment (Mudflap sends a PDF
   *  receipt alongside the HTML email). */
  pdfB64?: string;
}
export interface InboundFuelEmailResponse {
  ok:                  boolean;
  transactionId?:      string;
  /** 'inserted' on first ingest, 'duplicate' on re-ingest of the same
   *  provider_transaction_id. Both are non-errors. */
  result?:             'inserted' | 'duplicate';
  matchConfidence?:    number;
  matchStatus?:        FuelTransactionMatchStatus;
  /** Populated on parse failure so the GAS can log it. */
  error?:              string;
}

/** POST /v1/fuel-transactions/import — bulk-load from a CSV / old DB.
 *  Pre-parsed transactions, no email parsing involved. Idempotent. */
export interface BulkImportFuelTransactionsRequest {
  transactions: Array<Omit<FuelTransaction,
    'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'fuelReportId' |
    'matchStatus' | 'matchConfidence' | 'matchNotes' | 'matchedAt' | 'matchedBy'
  > & {
    /** Carry the legacy id forward for traceability. */
    legacyFormResponseId?: number;
  }>;
}
export interface BulkImportFuelTransactionsResponse {
  inserted:   number;
  duplicates: number;
  failed:     Array<{ providerTransactionId: string; error: string }>;
}

/** GET /v1/fuel-transactions — list with filters. */
export interface ListFuelTransactionsRequest {
  matchStatus?: FuelTransactionMatchStatus | 'all';
  from?:        string;
  to?:         string;
  q?:           string;
  limit?:       number;
  offset?:      number;
}
export interface ListFuelTransactionsResponse {
  fuelTransactions: FuelTransaction[];
  total:            number;
  limit:            number;
  offset:           number;
}

/** PATCH /v1/fuel-transactions/:id/match — manual link / unlink. */
export interface MatchFuelTransactionRequest {
  /** null to unlink. */
  fuelReportId: string | null;
  matchNotes?:  string;
}
export interface MatchFuelTransactionResponse { fuelTransaction: FuelTransaction; }

/** POST /v1/fuel-transactions/:id/auto-match — single-row matcher.
 *  Idempotent: re-running on an already-matched row is a no-op echo.
 *  `result` mirrors the underlying matcher outcome plus an
 *  `already_matched` short-circuit for status quo rows. */
export interface SingleRowAutoMatchResponse {
  result:          'auto_matched' | 'unmatched' | 'already_matched';
  confidence?:     number;
  fuelTransaction: FuelTransaction;
}

/** PATCH /v1/fuel-transactions/:id/assign — set driver / asset directly
 *  on a card transaction, independent of any driver fuel_report.
 *
 *  When a card transaction can't be paired with a driver report
 *  (driver paid out of pocket, forgot to file, owner-op swiped on
 *  someone else's behalf), the dispatcher still wants the spend
 *  attributed to a driver + truck for cost analysis. This endpoint
 *  writes driver_id / asset_id directly without requiring a report.
 *
 *  applyToSimilar — when true, the server finds every other unmatched
 *  fuel_transaction in the same org whose driver_name matches this
 *  one's driver_name (case-insensitive trim) and applies the same
 *  driver/asset assignment. Useful for backfilling "all of Kevin's
 *  transactions" in one click. */
export interface AssignFuelTransactionRequest {
  driverId:        number | null;
  assetId:         number | null;
  applyToSimilar?: boolean;
}
export interface AssignFuelTransactionResponse {
  fuelTransaction: FuelTransaction;
  /** When applyToSimilar=true, how many additional rows were updated. */
  alsoUpdated?:    number;
}

// Re-export the enums for caller convenience.
export type { FuelTransactionMatchStatus, FuelTransactionProvider };

// ── Ramp (card-spend) transactions ──────────────────────────────────────

import type {
  RampTransaction,
  RampTransactionMatchStatus,
} from './domain';

export interface ListRampTransactionsRequest {
  matchStatus?:      RampTransactionMatchStatus | 'all';
  assetId?:          number;
  trailerId?:        number;
  cardholderUserId?: string;
  category?:         string;
  from?:             string;
  to?:               string;
  q?:                string;
  limit?:            number;
  offset?:           number;
}
export interface ListRampTransactionsResponse {
  rampTransactions: RampTransaction[];
  total:            number;
  limit:            number;
  offset:           number;
}

/** Manual match. Pass both assetId and trailerId as null to unlink. */
export interface MatchRampTransactionRequest {
  assetId?:    number | null;
  trailerId?:  number | null;
  matchNotes?: string | null;
}
export interface MatchRampTransactionResponse {
  rampTransaction: RampTransaction;
}

export interface MarkRampNotApplicableResponse {
  rampTransaction: RampTransaction;
}

export interface RunRampSyncResponse {
  ok:      boolean;
  skipped: boolean;
  reason?: string;
  orgId?:  string;
  from?:   string;
  to?:     string;
  result?: {
    fetched:       number;
    inserted:      number;
    updated:       number;
    duplicates:    number;
    failed:        number;
    autoMatched:   number;
    notApplicable: number;
  };
}

// ── /expenses dashboard ─────────────────────────────────────────────────

/** One bucket in the /expenses summary. `total` and `count` are for the
 *  requested period; `prevTotal` / `prevCount` are for the immediately-
 *  prior window of equal length (for Δ callouts on the tile). Extra
 *  bucket-specific signals go in `meta` — Payroll uses it to expose
 *  the 4-way sub-bucket breakdown; Uncategorized uses it for the CTA
 *  count. */
/** Special bucketId marker on /summary for the "Uncategorized card spend"
 *  CTA row. Real buckets have UUID ids. */
export const UNCATEGORIZED_BUCKET_ID = '__uncategorized__' as const;
export type SummaryBucketKey = string | typeof UNCATEGORIZED_BUCKET_ID;

/** One rolled-up bucket on the /summary response. Top-level tiles are
 *  the outer array; drill-in children (sub-buckets) live under
 *  `children` already rolled up. */
export interface ExpenseBucketSummary {
  bucketId:       SummaryBucketKey;
  parentBucketId: string | null;
  name:           string;
  icon?:          string;
  color?:         string;
  systemRole?:    string;
  total:          number;
  count:          number;
  prevTotal:      number;
  prevCount:      number;
  children?:      ExpenseBucketSummary[];
}


export interface ExpensesSummaryResponse {
  period:  { from: string; to: string };
  buckets: ExpenseBucketSummary[];
}

/** Normalized event for the /expenses "Latest activity" feed. */
export interface ExpenseEvent {
  source:      'fuel' | 'payroll' | 'cards';
  id:          string;
  at:          string;       // ISO
  amount:      number;
  description: string;
  assetId?:    number;
  driverName?: string;
  /** Where this event lives in the app so the row can link deep. */
  href?:       string;
}

export interface ExpensesActivityResponse {
  events: ExpenseEvent[];
}

// ── Unified expense ledger ──────────────────────────────────────────────
//
// One normalized row shape for every dollar out, across all sources.
// Powers the /expenses workspace's main table. Source-specific payloads
// ride along so the detail panel never needs a second fetch.

export type LedgerSource = 'ramp' | 'mudflap' | 'payroll' | 'entry' | 'recurring';

export interface LedgerRow {
  /** Unique across sources: "<source>:<ref>" — stable within a window. */
  rowKey:      string;
  source:      LedgerSource;
  /** Underlying record id (ramp txn uuid, entry uuid, rule uuid, …). */
  refId:       string;
  /** YYYY-MM-DD display date. Payroll rows use the week's Saturday;
   *  recurring postings use the window start. */
  date:        string;
  description: string;
  /** Secondary line — memo, kind tag, proration math, load counts. */
  sub?:        string;
  amount:      number;
  bucketId:    string | null;   // null = uncategorized (ramp only)
  bucketName:  string | null;
  /** True when the bucket can be reassigned directly from the row
   *  (ramp txns + manual entries). Payroll/fuel route via system_role;
   *  recurring postings change via their rule. */
  bucketEditable: boolean;
  /** Matched unit from the memo matcher (ramp) or the fuel card link
   *  (mudflap). Labels resolve client-side from the fixtures. */
  assetId?:    number;
  trailerId?:  number;

  // Source payloads for the detail panel (exactly one is set):
  ramp?:      import('./domain').RampTransaction;
  entry?:     import('./domain').ExpenseEntry;
  /** For recurring rows `prorated` is the posting amount (one full
   *  occurrence — the ledger emits one row per scheduled date). */
  recurring?: import('./domain').RecurringExpense & { prorated: number };
  payroll?:   { driverName: string; weekStart: string; loadPay: number; adjustments: number; loadCount: number };
  mudflap?:   { location: string | null; driverName: string | null; gallons: number | null; assetId: number | null };
}

export interface ExpensesLedgerResponse {
  period: { from: string; to: string };
  rows:   LedgerRow[];
  /** Row count before the limit safeguard was applied. */
  total:  number;
}

// ── Recurring expenses CRUD ─────────────────────────────────────────────

import type {
  RecurringExpense,
  RecurringExpenseCadence,
} from './domain';

export interface ListRecurringExpensesResponse {
  recurringExpenses: RecurringExpense[];
}

export interface CreateRecurringExpenseRequest {
  bucketId:       string;
  kind?:          string;
  label:          string;
  amount:         number;
  cadence:        RecurringExpenseCadence;
  effectiveFrom:  string;   // YYYY-MM-DD
  effectiveTo?:   string;
  notes?:         string;
}

export interface UpdateRecurringExpenseRequest {
  bucketId?:      string;
  kind?:          string | null;
  label?:         string;
  amount?:        number;
  cadence?:       RecurringExpenseCadence;
  effectiveFrom?: string;
  effectiveTo?:   string | null;
  notes?:         string | null;
}

export interface RecurringExpenseResponse {
  recurringExpense: RecurringExpense;
}

export interface BackfillRampCategoriesResponse {
  scanned:     number;
  categorized: number;
  perCategory: Record<string, number>;
}

// ── Expense entries CRUD (one-off / ad-hoc) ─────────────────────────────

import type { ExpenseEntry, RampCategoryRule } from './domain';

export interface ListExpenseEntriesRequest {
  from?:     string;
  to?:       string;
  bucketId?: string;
  kind?:     string;
  limit?:    number;
  offset?:   number;
}
export interface ListExpenseEntriesResponse {
  expenseEntries: ExpenseEntry[];
  total:          number;
}

export interface CreateExpenseEntryRequest {
  bucketId: string;
  kind?:    string;
  date:     string;   // YYYY-MM-DD
  amount:   number;
  label:    string;
  notes?:   string;
}
export interface UpdateExpenseEntryRequest {
  bucketId?: string;
  kind?:     string | null;
  date?:     string;
  amount?:   number;
  label?:    string;
  notes?:    string | null;
}
export interface ExpenseEntryResponse {
  expenseEntry: ExpenseEntry;
}

// ── Ramp category rules CRUD ────────────────────────────────────────────

export interface ListRampCategoryRulesResponse {
  rules: RampCategoryRule[];
}
export interface CreateRampCategoryRuleRequest {
  pattern:  string;
  isRegex?: boolean;
  bucketId: string;
  assetScope?: import('./domain').RampRuleAssetScope;   // default 'any'
  priority?: number;
  notes?:    string;
}
export interface UpdateRampCategoryRuleRequest {
  pattern?:  string;
  isRegex?:  boolean;
  bucketId?: string;
  assetScope?: import('./domain').RampRuleAssetScope;
  priority?: number;
  notes?:    string | null;
}
export interface RampCategoryRuleResponse {
  rule: RampCategoryRule;
}
export interface SeedRampCategoryRulesResponse {
  seeded:  number;
  skipped: number;
}

// ── Expense buckets CRUD ────────────────────────────────────────────────

import type { ExpenseBucket, ExpenseBucketTreeNode, ExpenseBucketSystemRole } from './domain';

export interface ListExpenseBucketsResponse {
  /** Flat list, sorted top-level first (parentBucketId null) then by
   *  parent then by sort_order. Client can either use directly or
   *  build a tree. */
  buckets: ExpenseBucket[];
  /** Same data as `buckets` but already tree-shaped. */
  tree:    ExpenseBucketTreeNode[];
}

export interface CreateExpenseBucketRequest {
  name:            string;
  parentBucketId?: string | null;
  icon?:           string;
  color?:          string;
  sortOrder?:      number;
  systemRole?:     ExpenseBucketSystemRole | null;
}
export interface UpdateExpenseBucketRequest {
  name?:           string;
  icon?:           string | null;
  color?:          string | null;
  sortOrder?:      number;
  systemRole?:     ExpenseBucketSystemRole | null;
  parentBucketId?: string | null;
}
export interface ExpenseBucketResponse {
  bucket: ExpenseBucket;
}

/** Reordering: pass an ordered array of ids per parent (top-level uses
 *  parentBucketId=null). */
export interface ReorderExpenseBucketsRequest {
  parentBucketId: string | null;
  orderedIds:     string[];
}

/** Returned by DELETE when the bucket still has references. */
export interface DeleteExpenseBucketBlockedResponse {
  error:       'delete_blocked';
  detail:      string;
  references: {
    recurring:  number;
    entries:    number;
    rampTxns:   number;
    rampRules:  number;
    subBuckets: number;
    systemRole: ExpenseBucketSystemRole | null;
  };
}

// ── /v1/odometer-readings ───────────────────────────────────────────────
//
// Source-agnostic odometer storage. Backed by the motive_odometer_readings
// table (table name kept for backward compat). Three writers:
//   1. Motive snapshot cron — vehicle_id set, asset_id null, source='motive'
//   2. Bulk historical import (this endpoint) — asset_id set, vehicle_id
//      optional, source='import'
//   3. Manual entry UI (future) — source='manual'

/**
 * POST /v1/odometer-readings/import — bulk historical / one-off import.
 *
 * Each reading MUST reference an asset (by id) or a Motive vehicle id.
 * Most imports come from a non-Motive system, so assetId is the
 * normal path. Server validates the asset exists in the org and that
 * the reading's capturedAt falls within the asset's active window
 * (activeFrom..activeTo) — readings outside the window get skipped
 * with a per-row error so historical "the truck wasn't ours yet" or
 * "the truck was already retired" data doesn't pollute the chart.
 *
 * Idempotent on (asset_id or vehicle_id, calendar_day) — re-running
 * a CSV after fixing a column is safe.
 */
export interface BulkImportOdometerReadingsRequest {
  readings: Array<{
    /** At least ONE of assetId / motiveVehicleId / unit must be set.
     *  Priority: assetId > motiveVehicleId > unit. `unit` matches
     *  against assets.unit (the truck door number), which is the
     *  easiest identifier when importing from an external system
     *  that doesn't know our FleetCal asset ids. */
    assetId?:         number;
    motiveVehicleId?: number;
    unit?:            string;
    /** Number on the vehicle's door / unit. Stored as label fallback
     *  if we don't have it via the asset lookup. */
    vehicleNumber?:   string;
    /** Reading in miles. Either the actual gauge reading or the
     *  computed cumulative value from the source system. */
    odometerMiles:    number;
    /** When the reading was taken in the SOURCE system (the truck's
     *  fueling/inspection/log timestamp). Required so we can validate
     *  against the asset's active window. */
    capturedAt:       string;     // ISO timestamp
    /** Optional Motive-style true_odometer if your source has the
     *  distinction. Falls back to odometerMiles when omitted. */
    trueOdometerMiles?: number;
    /** Same as Motive's located_at — when the source system thinks
     *  the reading was actually taken (vs when it was recorded).
     *  Optional. */
    locatedAt?:       string;
  }>;
}
export interface BulkImportOdometerReadingsResponse {
  inserted:   number;
  duplicates: number;
  /** Rows skipped because the captured_at fell outside the asset's
   *  active window. Common during initial import — surfaced
   *  separately so the user can see what they imported vs what was
   *  intentionally dropped. */
  outOfWindow: number;
  failed:     Array<{ identifier: string; error: string }>;
}

// ── /v1/org-api-keys ────────────────────────────────────────────────────

export interface CreateOrgApiKeyRequest {
  name:   string;
  scopes: string[];
}
export interface CreateOrgApiKeyResponse {
  id:        string;
  /** Plaintext key — shown ONCE, never retrievable. Caller must
   *  store it somewhere safe immediately. */
  key:       string;
  keyPrefix: string;
  name:      string;
  scopes:    string[];
  createdAt: string;
}
export interface ListOrgApiKeysResponse {
  apiKeys: Array<{
    id:         string;
    name:       string;
    keyPrefix:  string;
    scopes:     string[];
    createdAt:  string;
    createdBy?: string;
    lastUsedAt?:string;
  }>;
}

// ── /v1/driver/maintenance-reports + /v1/maintenance-reports ────────────

/** POST /v1/driver/maintenance-reports — driver submits a report.
 *  Exactly one of assetId / trailerId is required. */
export interface CreateMaintenanceReportRequest {
  assetId?:    number;
  trailerId?:  number;
  description: string;
  reportedAt?: string;
  latitude?:   number;
  longitude?:  number;
  state?:      string;
}
export interface CreateMaintenanceReportResponse { report: MaintenanceReport; }

/** GET /v1/driver/maintenance-reports/history — recent reports on
 *  an asset/trailer, regardless of which driver filed them. Used by
 *  the driver app's "what's been reported on this truck" rail. */
export interface ListMaintenanceReportHistoryResponse {
  reports: MaintenanceReport[];
}

/** GET /v1/maintenance-reports — ops list with filters. */
export interface ListMaintenanceReportsQuery {
  status?:    MaintenanceReportStatus;
  assetId?:   number;
  trailerId?: number;
  driverId?:  number;
  from?:      string;
  to?:        string;
  limit?:     number;
  offset?:    number;
}
export interface ListMaintenanceReportsResponse {
  reports: MaintenanceReport[];
  total:   number;
  limit:   number;
  offset:  number;
}

export interface GetMaintenanceReportResponse { report: MaintenanceReport; }

/** PATCH /v1/maintenance-reports/:id — ops triage. */
export interface UpdateMaintenanceReportRequest {
  status?: MaintenanceReportStatus;
}
export interface UpdateMaintenanceReportResponse { report: MaintenanceReport; }

/** POST /v1/maintenance-reports/:id/convert — promote a report to
 *  an action item. The action item inherits asset/trailer + report_id;
 *  the operator supplies the triage fields (title, priority, etc.).
 *  Server transactionally flips report.status -> 'converted' and sets
 *  report.action_item_id. */
export interface ConvertMaintenanceReportRequest {
  title?:          string;
  description?:    string;
  category?:       MaintenanceCategory;
  priority?:       MaintenancePriority;
  outOfService?:   boolean;
  scheduledDate?:  string;
  dueDate?:        string;
}
export interface ConvertMaintenanceReportResponse {
  report:      MaintenanceReport;
  actionItem:  MaintenanceActionItem;
}

/** GET /v1/maintenance-reports/photos/:id/url — signed read URL. */
export interface GetMaintenanceReportPhotoUrlResponse {
  url: string;
}

// ── /v1/maintenance-action-items ────────────────────────────────────────

/** POST /v1/maintenance-action-items — ad-hoc create.
 *  Exactly one of assetId / trailerId required. */
export interface CreateMaintenanceActionItemRequest {
  assetId?:        number;
  trailerId?:      number;
  title:           string;
  description?:    string;
  category?:       MaintenanceCategory;
  priority?:       MaintenancePriority;
  outOfService?:   boolean;
  scheduledDate?:  string;
  dueDate?:        string;
  vendor?:         string;
  estimatedCost?:  number;
  /** Optionally pre-link to a calendar event at create time. Used when
   *  the dispatcher creates a work order directly from a maintenance
   *  block on the calendar. */
  eventId?:        string;
}
export interface CreateMaintenanceActionItemResponse { actionItem: MaintenanceActionItem; }

/** GET /v1/maintenance-action-items — list with filters. */
export interface ListMaintenanceActionItemsQuery {
  status?:        MaintenanceActionStatus;
  priority?:      MaintenancePriority;
  category?:      MaintenanceCategory;
  outOfService?:  boolean;
  assetId?:       number;
  trailerId?:     number;
  /** Inclusive `scheduledDate >= from`. */
  scheduledFrom?: string;
  scheduledTo?:   string;
  /** Filter to work orders linked to this calendar event. The calendar
   *  side uses this to populate the "Linked work orders" section on
   *  a non-revenue maintenance event. */
  eventId?:       string;
  limit?:         number;
  offset?:        number;
}
export interface ListMaintenanceActionItemsResponse {
  actionItems: MaintenanceActionItem[];
  total:       number;
  limit:       number;
  offset:      number;
}

export interface GetMaintenanceActionItemResponse { actionItem: MaintenanceActionItem; }

export interface UpdateMaintenanceActionItemRequest {
  title?:          string;
  description?:    string | null;
  category?:       MaintenanceCategory;
  priority?:       MaintenancePriority;
  status?:         MaintenanceActionStatus;
  outOfService?:   boolean;
  scheduledDate?:  string | null;
  dueDate?:        string | null;
  vendor?:         string | null;
  estimatedCost?:  number | null;
  actualCost?:     number | null;
  completedBy?:    string | null;
  /** Legacy single-link field. Semantics preserved for back-compat:
   *    • `string` → REPLACE the link set with just this event id.
   *    • `null`   → CLEAR all links.
   *    • omitted  → no change.
   *  For multi-link UI flows prefer `eventIds` below. */
  eventId?:        string | null;
  /** Replace the entire set of linked events in one PATCH. Pass an
   *  empty array to clear, or a deduplicated list of event UUIDs to
   *  set. Takes precedence over `eventId` if both are present. */
  eventIds?:       string[];
}
export interface UpdateMaintenanceActionItemResponse { actionItem: MaintenanceActionItem; }

/** POST /v1/maintenance-action-items/:id/photos — multipart upload.
 *  Body is `file` as a single multipart field. One file per request
 *  (the client loops over selected files) to keep the wire shape
 *  trivial and per-file partial-failure handling possible. */
export interface UploadMaintenanceActionItemPhotoResponse {
  photo: MaintenanceActionItemPhoto;
}

/** DELETE /v1/maintenance-action-items/photos/:id */
export interface DeleteMaintenanceActionItemPhotoResponse { ok: true; }

/** Re-export so callers that import from this module exclusively get
 *  the maintenance shapes too. */
export type {
  MaintenanceReport, MaintenanceReportStatus, MaintenanceReportPhoto,
  MaintenanceActionItem, MaintenanceActionItemPhoto, MaintenanceCategory, MaintenancePriority, MaintenanceActionStatus,
};

// ── /v1/performance-events — Motive safety-event bell ──────────────────

export type PerformanceEventDispatchStatus =
  | "new"
  | "confirmed"
  | "dismissed"
  | "notified";

export interface PerformanceEventRow {
  id:                 number;
  event_type:         string;               // 'hard_accel' | 'hard_brake' | 'hard_corner' | v2 types
  event_time:         string;               // ISO
  end_time:           string | null;
  duration:           number | null;
  intensity:          string | null;
  vehicle_id:         number;
  vehicle_number:     string | null;        // Motive-side (drawer diagnostics only — don't display in lists)
  asset_id:           number | null;
  asset_name:         string | null;        // fleetcal-side display name (assets.name), preferred label
  asset_unit:         string | null;        // fleetcal-side fleet/unit number (assets.unit)
  asset_color:        string | null;        // hex from assets.color — bell accent bar
  driver_id:          number | null;        // Motive driver id (may be stale)
  driver_first_name:  string | null;
  driver_last_name:   string | null;
  // ── Calendar-resolved (authoritative). Populated by the API from the
  //    covering events row on the asset, NOT stored on the DB row. Null
  //    means neither the calendar nor driver_asset_prefs had a match.
  resolved_driver_id:   number | null;
  resolved_driver_name: string | null;
  resolved_load_num:    string | null;
  /** Load event title from the covering calendar row — e.g.
   *  "SLC → Portland" or a broker/customer label if that's how the
   *  dispatcher named it. Panel/drawer show this alongside load_num. */
  resolved_load_title:  string | null;
  lat:                number | null;
  lon:                number | null;
  location_label:     string | null;
  dispatch_status:    PerformanceEventDispatchStatus;
  assigned_driver_id: number | null;        // fleetcal drivers.id (dispatcher-confirmed)
  dispatch_note:      string | null;
  dispatched_at:      string | null;
  dispatched_by_name: string | null;
  notified_at:        string | null;
  notified_driver_id: number | null;
  notified_message:   string | null;
  /** Resolved from drivers.name at read time — reflects the driver who
   *  ACTUALLY received the push, which can differ from
   *  resolved_driver_name when the dispatcher reassigned before sending. */
  notified_driver_name: string | null;
  // ── Dispute workflow (driver challenges the alert, dispatcher reviews) ─
  dispute_status:      "none" | "pending" | "accepted" | "rejected";
  disputed_at:         string | null;
  dispute_reason:      string | null;
  dispute_reviewed_at: string | null;
  dispute_reviewer_id: string | null;
  dispute_resolution:  string | null;
  /** Derived from raw.event_intensity + raw.metadata.severity via
   *  deriveSeverity() — computed on every read, not stored. See
   *  packages/types/severity.ts for thresholds. */
  severity_level:    "low" | "moderate" | "severe" | null;
  severity_score:    number | null;   // 0–100 for the bar meter fill
  severity_display:  string | null;   // e.g. "12.2 mph/s" or "0.6 s"
  severity_metric:   string | null;   // e.g. "Braking intensity"
  severity_inverted: boolean;         // true when lower = worse (tailgating)
}

// ── /v1/driver-safety-scoring — 30-day rolling safety score ────────────
//
// Miles-normalized penalty using severity + event-type weights, with a
// linear recency falloff inside the window. See apps/api/src/routes/
// driver-safety-scoring.ts for the formula.

export interface DriverSafetyScoreRow {
  driverId:      number;
  driverName:    string;
  /** 0–100. Higher = safer. Anchored to fleet median = 80 so the
   *  fleet-average driver always lands near 80 regardless of how event-
   *  heavy the fleet is. Null when a driver had zero recorded miles
   *  in the window (score would be undefined). */
  safetyScore:   number | null;
  /** Total safety events attributed to this driver in the window. */
  totalEvents:   number;
  /** Count of severity_level = 'moderate' events. */
  moderateEvents: number;
  /** Count of severity_level = 'severe' events — surfaced as a chip on
   *  the drivers page even for drivers whose score is fine overall. */
  severeEvents:  number;
  /** Miles driven in the window per motive_driving_periods.miles,
   *  filtered to display_eligible periods (matches how movements are
   *  used elsewhere). Denominator of the penalty. */
  milesDriven:   number;
  /** Raw penalty magnitude (severity-weighted events per 1000 miles).
   *  Useful for tooltips + debugging without exposing the K constant. */
  penaltyPer1kMi: number;
  /** True when the auto-flag rule triggers. See endpoint doc for
   *  criteria — dispatcher-facing "needs coaching" signal. */
  flagged:       boolean;
  /** Same score for the prior 30-day window (day -60 to day -30) so we
   *  can render a trend indicator. Null when no data. */
  prevSafetyScore:  number | null;
  /** How this driver ranks 1..N against peers by safety score
   *  (1 = best, N = worst). Ties get the same rank. Null when
   *  safetyScore is null. */
  rank:          number | null;
}

export interface DriverSafetyFleetSummary {
  driverCount:   number;
  fleetMedian:   number | null;
  fleetMean:     number | null;
  /** Total miles across the whole fleet for the window. Shown in the
   *  page-header tile alongside "N drivers · X.Y M miles". */
  fleetMiles:    number;
  /** Total events across the whole fleet for the window. */
  fleetEvents:   number;
  /** Fleet median penalty-per-1000-miles — the anchor the score curve
   *  uses. Rendered in the header tooltip so the number is auditable. */
  fleetMedianPenalty: number;
  /** True when the fleet had fewer than 3 drivers meeting the min-miles
   *  threshold, so we used a hardcoded reference penalty instead of a
   *  computed median. Small-fleet honesty flag. */
  medianIsFallback: boolean;
  /** Window covered — echoed back so the client can show the range in
   *  a subtitle without recomputing dates. */
  fromDate:      string; // YYYY-MM-DD
  toDate:        string; // YYYY-MM-DD
  days:          number;
}

export interface ListDriverSafetyScoresResponse {
  drivers: DriverSafetyScoreRow[];
  fleet:   DriverSafetyFleetSummary;
}

/** Subset of the Motive v2 driver_performance_events payload we surface
 *  on `include=raw` requests. Only fields the panel/drawer actually read —
 *  a full echo of Motive's response is much larger. */
export interface MotivePerfRaw {
  /** GPS trace of the event itself — 1Hz samples during the incident.
   *  Rendered as a polyline on the map. */
  m_gps_lat?:  number[];
  m_gps_lon?:  number[];
  m_gps_spd?:  number[];
  m_veh_spd?:  number[];
  max_speed?:  number;
  min_speed?:  number;
  coaching_status?: string | null;
  primary_behavior?: string[];
  event_intensity?: { name: string; value: number; unit_type: string } | null;
  time_to_hit_range?: { unit: string; max_time_to_hit_range: number; min_time_to_hit_range: number } | null;
  camera_media?: {
    id: number;
    cam_type: string;
    duration: number;
    available: boolean;
    start_time: string;
    uploaded_at: string;
    cam_positions: string[];
    /** Motive stages video in three phases: (1) event fires, JPG stills
     *  land immediately; (2) raw video sits on Motive's side; (3) MP4
     *  transcode is triggered on demand or by policy. Most hard-brake
     *  events never auto-transcode — this field says whether it did. */
    auto_transcode_status?: string | null;
    /** Present only when the sync request asked for `media_required=true`.
     *  Signed S3 URLs (~7-day TTL from the header we observed on the
     *  actual response), so older events may show broken images too —
     *  same on-demand refresh path handles both. */
    downloadable_images?: {
      front_facing_jpg_url?:  string | null;
      driver_facing_jpg_url?: string | null;
    } | null;
    /** Present when Motive transcoded a video for this event. In
     *  practice: null for most hard_brake/hard_accel unless a fleet
     *  manager explicitly requested a video recall. Populated for
     *  higher-severity events (tailgating, distraction, etc.). */
    downloadable_videos?: {
      front_facing_plain_url?:       string | null;
      driver_facing_plain_url?:      string | null;
      front_facing_enhanced_url?:    string | null;
      dual_facing_enhanced_url?:     string | null;
      front_facing_enhanced_ai_viz_url?: string | null;
      dual_facing_enhanced_ai_viz_url?:  string | null;
    } | null;
  } | null;
}

/** Motive driving-period row surfaced in the panel's sidecar. Used to
 *  draw the between-load movement OD line on the panel map. */
export interface PerformanceEventMovement {
  id: number;
  vehicle_id: number;
  driver_first_name: string | null;
  driver_last_name:  string | null;
  start_time: string;
  end_time:   string | null;
  origin:     string | null;
  destination: string | null;
  origin_lat: number | null;
  origin_lon: number | null;
  destination_lat: number | null;
  destination_lon: number | null;
  miles:      number | null;
}

// ── /v1/reports/loads — load-shaped report endpoint ────────────────────
//
// Distinct from /v1/loads (which is actually events-flavored — one row per
// event/leg, with the parent load joined onto each row). The report
// endpoint queries the loads table directly and returns ONE row per load,
// with the pickup leg's fields elevated as the load's representative
// fields for single-column displays. Designed for dashboards, accounting
// exports, and any consumer that thinks "one row per load."
//
// A relay load shows up exactly once, with the pickup leg in the headline
// fields and all legs in `legs[]`.

/** One leg of a load. A non-relay load has exactly one leg with
 *  relayRole=undefined. A relay load has N legs ordered by legIndex:
 *  first='pickup', last='delivery', middle='transfer'. */
export interface LegSummary {
  eventId:     string;
  relayRole?:  "pickup" | "transfer" | "delivery";
  /** 0-based position of this leg within the load. */
  legIndex?:   number;
  /** ISO timestamp of this leg's start (= pickup time for the pickup leg). */
  start:       string;
  /** ISO timestamp of this leg's end. */
  end:         string;
  status:      LoadStatus;
  priority?:   boolean;
  assetId:     number;
  driverId?:   number;
  driverName?: string;
  driverPay?:  number;
  /** Routed road miles for this leg (cached server-side). */
  loadedMiles?: number;
  trailerId?:  number;
  /** Stops belonging to this leg, ordered by sequence. */
  stops:       Stop[];
}

/** Load-shaped summary — one entry per load_id. */
export interface LoadSummary {
  // Identity
  loadId:           string;
  internalLoadId:   number;
  loadNum?:         string;
  /** True iff this load has two or more legs (relay_role set on the events). */
  isRelay:          boolean;
  /** Pickup-leg title — surfaced here so single-row displays (accounting,
   *  reports) have a label without joining back to the events table.
   *  Relay loads use the pickup leg's title; non-relay loads have one
   *  leg, so this is just its title. */
  title?:           string;

  // Customer / dispatch
  broker?:          string;
  customerId?:      string;
  dispatcher?:      string;
  createdByName?:   string;

  // Money
  /** Linehaul rate (UI label: "Linehaul"). */
  loadPrice?:       number;
  /** Server-computed: linehaul + billable accessorials. Read-only.
   *  UI label: "Total" (only shown when accessorials make it differ
   *  from loadPrice). */
  totalBillable?:   number;
  /** Load-level accessorials. Per-leg accessorials are a future split. */
  accessorials?:    Accessorial[];

  // Equipment & content (load-level summary)
  commodity?:       string;
  weight?:          number;
  trailerType?:     string;
  refNums?:         RefNum[];
  rateConPdf?:      string | null;

  // Notes
  notes?:           string;
  internalNotes?:   InternalNote[];

  // Billing / closeout state
  billingStatus?:   BillingStatus;
  flaggedReason?:   string;
  flaggedNote?:     string;
  flaggedAt?:       string;
  flaggedBy?:       string;
  verifiedAt?:      string;
  verifiedBy?:      string;
  invoiceDocIds?:   string[];
  /** Truck Order Not Used — POD requirement is waived for these. */
  isTonu?:          boolean;
  /** Per-load document counts (rate_con, pod, bol, lumper, scale,
   *  receipt, driver_sheet, invoice, other) — denormalized onto loads
   *  via DB trigger so reports don't need to JOIN documents. Same
   *  shape the /v1/closeout/queue endpoint returns in its docCounts
   *  side dictionary. */
  documentCounts?:  Record<string, number>;
  /** Latest POD upload timestamp for this load (max(uploaded_at) over
   *  load_documents WHERE kind='pod'). Used by the drivers scorecard
   *  to compute "POD within 24h of delivery." Undefined if no POD has
   *  been uploaded — consumers should treat that as "not yet" and only
   *  count the load as on-time when this is set AND ≤ 24h after
   *  deliveryAt. */
  podUploadedAt?:   string;

  // Audit
  auditLog?:        LoadAuditEntry[];

  // ── Elevated leg-level fields — for single-column displays.
  //    Always reflect the PICKUP leg (or the only leg, if single).
  //    Delivery-side counterparts are exposed below for relay tables.
  pickupAt:         string;
  pickupAssetId:    number;
  pickupDriverId?:  number;
  pickupDriverName?: string;
  pickupDriverPay?: number;
  pickupStatus:     LoadStatus;
  pickupPriority?:  boolean;
  pickupLoadedMiles?: number;

  // ── Delivery-side fields. For single-leg loads these equal the
  //    pickup-side fields — the delivery IS the pickup leg's end.
  deliveryAt:        string;
  deliveryAssetId:   number;
  deliveryDriverId?: number;
  deliveryDriverName?: string;
  deliveryDriverPay?: number;
  deliveryStatus:    LoadStatus;
  deliveryLoadedMiles?: number;

  // ── Convenience aggregates
  /** Sum of loadedMiles across all legs. undefined when any leg lacks miles. */
  totalLoadedMiles?: number;
  /** Sum of driverPay across all legs. undefined when no leg has driver pay. */
  totalDriverPay?:  number;

  // ── Full stop list, ordered pickup → delivery (no duplicates).
  //    Convenient for any consumer that wants "the stops" without
  //    dealing with leg structure. Per-leg stops live in `legs[].stops`.
  stops:            Stop[];

  // ── Per-leg breakdown for detail views.
  legs:             LegSummary[];

  // Lifecycle
  deletedAt?:       string;
  createdAt?:       string;
  updatedAt?:       string;
}

export interface ListLoadSummariesQuery {
  /** YYYY-MM-DD or full ISO timestamp. Filters loads whose PICKUP leg's
   *  start falls on/after this. */
  pickupFrom?:    string;
  /** Filters loads whose PICKUP leg's start falls on/before this. */
  pickupTo?:      string;
  /** YYYY-MM-DD or full ISO. Filters by DELIVERY leg's end (the load's
   *  final delivery). Combined with pickup filters as AND. */
  deliveryFrom?:  string;
  deliveryTo?:    string;
  /** Comma-separated broker names. Matches `loads.broker` case-insensitive. */
  brokers?:       string;
  /** Comma-separated customer uuids. */
  customerIds?:   string;
  /** Comma-separated load statuses. Matched against the PICKUP leg's status. */
  status?:        string;
  /** Comma-separated billing statuses (released, invoiced, paid, etc.). */
  billingStatus?: string;
  /** When 'true', includes soft-deleted loads. */
  includeDeleted?: string;
  /** Hard limit. Default 1000; reports rarely need more. */
  limit?:         string;
  offset?:        string;
}

export interface ListLoadSummariesResponse {
  loads: LoadSummary[];
  /** Total matching loads BEFORE limit/offset — used for pagination UI. */
  total: number;
}

// ── Errors (shared envelope) ────────────────────────────────────────────

export interface ApiErrorResponse {
  error: string;
  reason?: string;
  detail?: string;
  errors?: string[];
}
