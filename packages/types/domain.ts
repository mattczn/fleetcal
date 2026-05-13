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
  | "extra_stop"
  | "other";

export type AccessorialStatus = 'requested' | 'approved' | 'denied';

/** An accessorial counts as "pending" (impediment-to-closeout) when
 *  it's still 'requested' or has no status set yet. 'approved' and
 *  'denied' are both terminal — the broker has made a call. */
export function isAccessorialPending(a: Accessorial): boolean {
  return a.status !== 'approved' && a.status !== 'denied';
}

export interface Accessorial {
  id: string;
  category: AccessorialCategory;
  description?: string;
  amount: number;
  billable: boolean;
  status?: AccessorialStatus;
  /** When true, this accessorial flows into the driver's payroll as an adjustment. */
  payToDriver?: boolean;
  /** Optional: override which driver gets paid (defaults to the load's assigned driverName). Used for split/relay loads. */
  payDriverName?: string;
}

// ── LoadFollowUp ────────────────────────────────────────────────────────
//
// Threaded follow-up history for a load, stored as loads.follow_ups
// (jsonb). Each entry records who chased what and when, and can carry
// an optional `resolution` that mutated state at the same time —
// flipping an accessorial's status or clearing a manual flag.
//
// Combined with loads.flagged_* (manual flag), loads.accessorials
// (per-item status), and load_documents (POD presence), this drives
// the auto-flag logic in /closeout: a load shows up in Flagged when
// it has any unresolved impediment, drops out when they're all clear.

export type LoadFollowUpCategory =
  | 'pod'              // missing POD; waiting on the driver / facility
  | 'rate_con'         // need an updated rate con (accessorial added, etc.)
  | 'rate_dispute'     // broker disputing the linehaul rate
  | 'accessorial'      // detention / lumper / scale follow-up
  | 'other';

export interface LoadFollowUpResolution {
  type:           'accessorial_status' | 'flag_cleared' | 'mark_tonu';
  /** Required when type='accessorial_status'. */
  accessorialId?: string;
  /** Required when type='accessorial_status'. */
  newStatus?:     'approved' | 'denied';
  /** Required when type='mark_tonu'. true = mark TONU, false = un-mark. */
  isTonu?:        boolean;
}

export interface LoadFollowUp {
  id:        string;                       // client-generated uuid for stable list keys
  at:        string;                       // ISO timestamp the entry was posted
  by:        string | null;                // display name of the author
  note:      string;                       // free-form follow-up note
  category?: LoadFollowUpCategory;         // helps the UI badge + filter the timeline
  resolution?: LoadFollowUpResolution;     // state change applied alongside this entry
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

  // HR / compliance fields. All optional; filled in by the driver
  // via the driver app or by ops via the DriversModal.
  email?: string;
  address?: string;            // single text field — entered structured client-side
  licenseNumber?: string;
  licenseState?: string;       // 2-letter US abbreviation
  licenseExp?: string;         // YYYY-MM-DD
  medicalCardExp?: string;     // YYYY-MM-DD
  dob?: string;                // YYYY-MM-DD
}

export type DriverDocumentKind = 'license' | 'medical_card' | 'mvr' | 'other';
export const DRIVER_DOCUMENT_KINDS: readonly DriverDocumentKind[] = [
  'license', 'medical_card', 'mvr', 'other',
];

export interface DriverDocument {
  id:          string;
  orgId:       string;
  driverId:    number;
  kind:        DriverDocumentKind;
  fileName:    string;
  mimeType?:   string;
  sizeBytes?:  number;
  expiresOn?:  string;          // YYYY-MM-DD
  notes?:      string;
  uploadedAt:  string;
  uploadedBy:  string;
  /** 1-hour signed URL minted by list/get endpoints. */
  signedUrl?:  string;
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

export interface RateConPromptVariables {
  systemRole?:                string;
  timezone?:                  string;
  titleFormat?:               string;
  specialInstructionsFormat?: string;
}

export interface RateConSettings {
  promptVariables?:    RateConPromptVariables;
  promptInstructions?: string;
  fieldSettings?:      Record<string, boolean>;
}

/**
 * Org-level invoicing configuration. The values here render on every
 * generated invoice (company letterhead, MC#, remit-to, default terms)
 * and feed the broker batch flow downstream. Free-form remit-to lets
 * the user describe ACH or check-mailing details without us storing
 * raw account numbers in a structured column.
 */
export interface InvoiceSettings {
  // ── Identity ────────────────────────────────────────────
  /** Carrier name as it appears on the invoice. May differ from the
   *  org's display name (e.g. legal entity vs DBA). */
  companyName?: string;
  mcNumber?:    string;
  dotNumber?:   string;
  ein?:         string;

  // ── Billing address (the "from" block on the invoice) ──
  addressLine1?: string;
  addressLine2?: string;
  city?:         string;
  state?:        string;
  zip?:          string;

  // ── Contact (shown so brokers know who to ask) ─────────
  phone?: string;
  /** AR / accounting email — broker reaches out here with payment Qs. */
  email?: string;

  // ── Template config ────────────────────────────────────
  /** Default payment terms in days. 30 = "Net 30". */
  defaultPaymentTermsDays?: number;
  /** Free-form "Make checks payable to … / ACH to …" block. Kept as
   *  prose so the user controls exactly what gets printed. */
  remitToInstructions?: string;
  /** Optional footer / disclaimer printed on every invoice. */
  invoiceFooterNotes?: string;
  /** Optional prefix prepended to the invoice number (which defaults
   *  to internal_load_id). Empty string = no prefix. */
  invoiceNumberPrefix?: string;
}

export interface OrgSettings {
  showDriverPay: boolean;
  /** Per-org rate-con AI parsing config. See RateConSettings for shape. */
  rateConSettings?: RateConSettings;
  /** Per-org invoice template + identity config. See InvoiceSettings. */
  invoiceSettings?: InvoiceSettings;
}

// ── Customer ────────────────────────────────────────────────────────────

/** A single rep at a broker. Customers can have many of these — dispatchers
 *  route different loads through different contacts and want all of them on
 *  file. Phone-extension etc. lives in the phone string for now. */
export interface CustomerContact {
  /** Client-generated uuid. Stable list key for edit/delete UIs. */
  id:    string;
  name?: string;
  email?: string;
  phone?: string;
}

export interface Customer {
  id: string;
  name: string;          // canonical display name
  shortName?: string;    // abbreviated name used in auto-generated load titles
  aliases: string[];     // alternative names the AI may extract from rate-cons
  mcNum?: string;
  /** Multi-contact list. Empty array for new customers; legacy
   *  contactName/Email/Phone are backfilled into the first entry by
   *  migration 20260513_customers_contacts.sql. */
  contacts: CustomerContact[];
  /** @deprecated kept for read compat — new writes go to contacts[]. */
  contactName?: string;
  /** @deprecated kept for read compat — new writes go to contacts[]. */
  contactEmail?: string;
  /** @deprecated kept for read compat — new writes go to contacts[]. */
  contactPhone?: string;
  notes?: string;
  /**
   * Broker-specific guidance appended to the rate-con prompt when this
   * customer is detected. Free-form text, e.g. "Load # always follows 'Order:'."
   */
  parseHints?: string;
  /**
   * How invoices are submitted to this broker. Drives downstream
   * automation; pair with `invoiceEmail` or `invoicePortal`.
   */
  invoiceMethod?: 'email' | 'portal';
  /** AP/billing email address. Populated when invoiceMethod === 'email'. */
  invoiceEmail?:  string;
  /** Portal name + URL. Populated when invoiceMethod === 'portal'. */
  invoicePortal?: string;
  /**
   * Free-form additional billing guidance — payment terms, required docs,
   * factor preferences, anything not covered by the structured fields
   * above. Auto-populated by the rate-con parser on first capture.
   */
  invoiceInstructions?: string;
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
  /** Set when a dispatcher cancels the load. mode distinguishes the
   *  three cancel paths:
   *    'status'       — event stays on calendar, greyed out
   *    'remove-event' — event removed, load preserved in system
   *    'permanent'    — full delete via removeEvent (mirrored by loadDeleted)
   */
  loadCancelled?: {
    mode: 'status' | 'remove-event' | 'permanent';
    reason?: string;
    /** Snapshot of rate at the time of cancellation so a reinstate can restore it. */
    prevLoadPrice?: number;
    /** Snapshot of routed miles so a reinstate can restore them. */
    prevLoadedMiles?: number;
  };
  /** Set when a dispatcher reinstates a previously-cancelled load. */
  loadReinstated?: boolean;
  /** Set when the driver taps "Confirm" in the driver app. The
   *  `changedByName` field carries the driver's display name. */
  loadConfirmed?: boolean;
  /** Set when a manual "Send confirm push" was triggered from the load
   *  modal — dispatcher-initiated nudge. */
  confirmPushSent?: boolean;
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
  /**
   * Routed road miles on this leg, cached server-side so reports don't
   * have to re-call Google Directions. Set by the load modal when
   * calcRoadMiles resolves; cleared/recomputed whenever stops change.
   */
  loadedMiles?: number;
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
  /** Storage path. `null` is sent on the wire to explicitly clear the column. */
  rateConPdf?: string | null;

  // Stops — always an array; converters return [] when not yet loaded.
  stops: Stop[];

  // Relay (split loads)
  relayGroupId?: string;
  relayRole?: "pickup" | "delivery";
  partnerEventId?: string;
  partnerStops?: Stop[];
  partnerDriverName?: string;
  partnerAssetName?: string;
  /** Driver pay on the OTHER leg of the relay. Used by detail UIs that
   *  show pickup + delivery driver pay side-by-side. */
  partnerDriverPay?: number;

  // Audit
  auditLog?: LoadAuditEntry[];

  /** events.deleted_at — set on soft-deleted events; populated by reads
   *  that include deleted rows (trash UI). */
  deletedAt?: string;

  // ── Driver confirmation ────────────────────────────────────────────
  /** events.confirmed_at — set when the driver taps "Confirm" in the
   *  driver app. Cleared on reassignment so the new driver re-confirms. */
  confirmedAt?: string;
  /** events.confirmed_by — driver_id who confirmed. Survives until the
   *  load is reassigned. */
  confirmedBy?: number;
  /** events.confirm_reminder_sent_at — stamped by the cron sweep when a
   *  reminder push goes out. UI doesn't read this; cron uses it for
   *  idempotency between sweep ticks. */
  confirmReminderSentAt?: string;
  /** Unacknowledged dispatcher nudges currently pending for this event.
   *  Populated by the driver-side loads list endpoint and used to badge
   *  the load card. Array of kinds — count is the array length. */
  pendingNotificationKinds?: string[];

  // ── Billing / POD verification workflow ─────────────────────────────
  /**
   * Billing-state machine, independent of the operational status.
   * Defaults to 'pending'; advances as the dispatcher verifies POD and
   * accounting invoices + collects payment. 'on_hold' parks a load
   * until a flag is cleared.
   */
  billingStatus?: 'pending' | 'verified' | 'invoiced' | 'paid' | 'on_hold';
  /** Structured tag describing why a load is flagged for follow-up. */
  flaggedReason?: string;
  /** Free-form follow-up text (what we're waiting on, who to call). */
  flaggedNote?: string;
  flaggedAt?: string;
  flaggedBy?: string;
  /** Set when a dispatcher releases the load for invoicing. */
  verifiedAt?: string;
  verifiedBy?: string;
  /**
   * IDs of load_documents to bundle when accounting generates the
   * invoice. Defaults to all uploaded PODs; the review screen lets the
   * dispatcher trim/expand the set.
   */
  invoiceDocIds?: string[];

  /**
   * Threaded follow-up history. Each entry is one chase or status
   * change with author + timestamp. Drives the timeline shown in
   * the Flagged-bucket follow-up modal. See LoadFollowUp.
   */
  followUps?: LoadFollowUp[];

  /**
   * Truck Order Not Used. Carrier got dispatched + showed up but the
   * broker cancelled the move, so we bill a TONU fee with no POD.
   * Exempts the load from the closeout "missing POD" auto-flag.
   */
  isTonu?: boolean;

  /**
   * Per-kind doc counts for this load (load_documents keyed by `kind`).
   * Optional + populated by the list endpoints that opt into it
   * (driver loads list, closeout queue) — most queries leave it
   * undefined to keep the response cheap. Used client-side to flag
   * "delivered without POD" without an extra per-card fetch.
   *
   * Keyed by DocumentKind (from api.ts) at runtime — we declare as
   * a string-keyed record here to avoid a domain→api circular import.
   */
  documentCounts?: Record<string, number>;
}

// ── Invoice ─────────────────────────────────────────────────────────────
//
// An invoice is the billable artifact for one load. The fields rendered
// onto the document are snapshotted at issue time (see InvoiceSnapshot)
// so updating org_settings or the load afterward never changes what the
// broker sees on a sent invoice.

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void';

export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'draft', 'sent', 'paid', 'void',
];

/**
 * Line items on an invoice. Linehaul + accessorials get flattened into
 * this shape by the generator so the renderer doesn't have to special-
 * case anything.
 */
export interface InvoiceLineItem {
  description: string;
  /** Per-unit rate. For a flat-rate linehaul this equals `amount`. */
  rate:    number;
  units:   number;
  /** Free-form: "Flat", "Mile", "Hour", "Each". */
  uom:     string;
  amount:  number;
}

/** A stop as it renders on the invoice document.
 *
 *  Relay handoffs are excluded by the generator — they're internal-only
 *  dispatch markers and never appear on the broker-facing document. */
export interface InvoiceSnapshotStop {
  kind:      'Pickup' | 'Delivery' | 'Stop' | 'Drop';
  seq:       number;
  facility:  string;
  /** "CITY ST ZIP" uppercase, ready for direct render. */
  cityState: string;
  /** Combined reference numbers + piece counts in display order. */
  refs:      string;
}

/**
 * Everything needed to re-render an invoice exactly as it was issued.
 * Stored in invoices.snapshot (jsonb). Adding a new field is safe; the
 * renderer treats absent fields as defaults.
 */
export interface InvoiceSnapshot {
  // ── Company / carrier identity at issue time ─────────────────────
  companyName?:    string;
  companyLogoUrl?: string;            // Clerk org imageUrl frozen at issue
  addressLine1?:   string;
  addressLine2?:   string;
  city?:           string;
  state?:          string;
  zip?:            string;
  phone?:          string;
  email?:          string;
  mcNumber?:       string;
  dotNumber?:      string;
  ein?:            string;
  remitToInstructions?: string;
  invoiceFooterNotes?:  string;

  // ── Broker / bill-to ─────────────────────────────────────────────
  brokerName?:        string;
  brokerAddrLine1?:   string;
  brokerAddrLine2?:   string;

  // ── Order detail ─────────────────────────────────────────────────
  orderNo?:        string;            // load_num — broker's load number
  poNumber?:       string;
  orderDate?:      string;            // YYYY-MM-DD
  pickupDate?:     string;
  deliveredDate?:  string;
  loadNumber:      string;            // internal_load_id, stringified

  stops:           InvoiceSnapshotStop[];
  lineItems:       InvoiceLineItem[];

  totalCharges:    number;
  balanceDue:      number;
}

export interface Invoice {
  id:             string;
  orgId:          string;
  loadId:         string;
  customerId?:    string;

  invoiceNumber:  string;
  status:         InvoiceStatus;

  total:          number;
  issuedAt:       string;             // ISO timestamp
  dueAt?:         string;             // ISO timestamp

  snapshot:       InvoiceSnapshot;

  // Send tracking
  sentAt?:        string;
  sentTo?:        string;
  sentMethod?:    'email' | 'portal' | 'manual';

  // Payment tracking
  paidAt?:        string;
  paidAmount?:    number;
  paidMethod?:    'ach' | 'check' | 'wire' | 'other';
  paidNote?:      string;

  voidReason?:    string;

  createdAt:      string;
  updatedAt:      string;
}

// ── Fuel report ─────────────────────────────────────────────────────────
//
// Driver-submitted record of a fuel purchase. Authored from the driver
// app, which already knows the driver (signed-in user) and the asset
// (current assignment), and auto-detects state from GPS. Phase-2 layer
// (`fuel_transactions`) reconciles dollar amounts to these reports.

/** Reconciliation status against the future fuel_transactions table.
 *  - `pending`         — no transaction matched yet (default).
 *  - `matched`         — auto- or hand-linked to a transaction.
 *  - `no_transaction`  — operator confirmed no card transaction exists
 *                        (e.g. driver paid cash) so it stops appearing
 *                        in the unmatched queue. */
export type FuelReportMatchStatus = 'pending' | 'matched' | 'no_transaction';

export const FUEL_REPORT_MATCH_STATUSES: readonly FuelReportMatchStatus[] = [
  'pending',
  'matched',
  'no_transaction',
];

export interface FuelReportPhoto {
  id:           string;
  reportId:     string;
  fileName:     string;
  mimeType?:    string;
  sizeBytes?:   number;
  uploadedAt:   string;
  /** Pre-minted 1-hour signed URL when the parent list endpoint
   *  joined photos. Callers can re-fetch via the photo-URL endpoint
   *  if the link has expired. */
  signedUrl?:   string;
}

export interface FuelReport {
  id:             string;
  orgId:          string;

  driverId:       number;
  assetId:        number;

  reportedAt:     string;       // ISO timestamp
  state:          string;       // 2-letter US abbreviation
  latitude?:      number;
  longitude?:     number;

  dieselGallons:  number;
  defGallons?:    number;
  odometer?:      number;

  transactionId?: string;
  matchStatus:    FuelReportMatchStatus;

  submittedBy:    string;
  /** Internal notes — surfaced on the ops dashboard, not the driver app. */
  notes?:         string;
  createdAt:      string;

  /** Receipt photos, populated by list/detail endpoints. */
  photos?:        FuelReportPhoto[];
}

// ── Maintenance ─────────────────────────────────────────────────────────
//
// Two-layer model:
//   - MaintenanceReport      — driver-submitted raw input. Immutable
//                              once filed (only `status` changes via ops
//                              triage).
//   - MaintenanceActionItem  — ops's tracked work. Created from a report
//                              (reportId set) or ad-hoc.

export type MaintenanceReportStatus = 'open' | 'reviewed' | 'dismissed' | 'converted';
export const MAINTENANCE_REPORT_STATUSES: readonly MaintenanceReportStatus[] = [
  'open', 'reviewed', 'dismissed', 'converted',
];

export interface MaintenanceReportPhoto {
  id:           string;
  reportId:     string;
  fileName:     string;
  mimeType?:    string;
  sizeBytes?:   number;
  uploadedAt:   string;
  /** Signed read URL when the list endpoint mints one inline; otherwise
   *  callers fetch via GET /v1/maintenance-reports/photos/:id/url. */
  signedUrl?:   string;
}

export interface MaintenanceReport {
  id:             string;
  orgId:          string;

  driverId:       number;

  /** Exactly one of assetId / trailerId is non-null (DB-enforced). */
  assetId?:       number;
  trailerId?:     number;

  description:    string;

  reportedAt:     string;
  latitude?:      number;
  longitude?:     number;
  state?:         string;

  status:         MaintenanceReportStatus;
  /** Set when ops converts the report into an action item. */
  actionItemId?:  string;

  submittedBy:    string;
  createdAt:      string;

  /** Populated by list/detail endpoints that pre-fetch related photos. */
  photos?:        MaintenanceReportPhoto[];
}

export type MaintenanceCategory = 'repair' | 'pm' | 'inspection' | 'other';
export const MAINTENANCE_CATEGORIES: readonly MaintenanceCategory[] = [
  'repair', 'pm', 'inspection', 'other',
];

export type MaintenancePriority = 'urgent' | 'high' | 'normal' | 'low';
export const MAINTENANCE_PRIORITIES: readonly MaintenancePriority[] = [
  'urgent', 'high', 'normal', 'low',
];

export type MaintenanceActionStatus = 'open' | 'in_progress' | 'done';
export const MAINTENANCE_ACTION_STATUSES: readonly MaintenanceActionStatus[] = [
  'open', 'in_progress', 'done',
];

export interface MaintenanceActionItem {
  id:             string;
  orgId:          string;

  assetId?:       number;
  trailerId?:     number;

  title:          string;
  description?:   string;
  category:       MaintenanceCategory;
  priority:       MaintenancePriority;
  status:         MaintenanceActionStatus;
  outOfService:   boolean;

  scheduledDate?: string;       // YYYY-MM-DD
  dueDate?:       string;       // YYYY-MM-DD

  /** Source report, when this item was created from a driver submission. */
  reportId?:     string;

  completedAt?:   string;
  completedBy?:   string;

  // Phase-2 slots, exposed but typically empty in Phase 1.
  vendor?:        string;
  estimatedCost?: number;
  actualCost?:    number;

  createdBy:      string;
  createdAt:      string;
  updatedAt:      string;
}


// ── Load notifications (dispatcher → driver nudge timeline) ────────────

export type LoadNotificationKind =
  | 'confirm'
  | 'mark_pickup'
  | 'mark_delivery'
  | 'upload_pod'
  | 'report_trailer';

export const LOAD_NOTIFICATION_KINDS: readonly LoadNotificationKind[] = [
  'confirm', 'mark_pickup', 'mark_delivery', 'upload_pod', 'report_trailer',
];

export interface LoadNotification {
  id:             string;
  orgId:          string;
  eventId:        string;
  loadId?:        string;
  driverId:       number;
  kind:           LoadNotificationKind;
  sentAt:         string;
  sentByName:     string;
  /** Set by the server when the driver does the thing the nudge asked
   *  for (status advance, POD upload, trailer report, confirm). Until
   *  set the row is "pending" and counts toward the driver's badge. */
  acknowledgedAt?: string;
}
