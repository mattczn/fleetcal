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
  /** True when this stop is a relay leg boundary — the leg that ends here
   *  hands the trailer to the leg that starts here. A `type:'relay'` stop
   *  is always a handoff regardless of this flag; use `isHandoffStop()`
   *  rather than reading either signal directly. */
  isHandoff?: boolean;
  /** Handoff times for a handoff on a REAL stop (pickup/delivery/etc.),
   *  which can't reuse apptStart/apptEnd — those hold the stop's own
   *  appointment. Relay-point stops keep using apptStart/apptEnd.
   *  `handoffTimesOf()` normalizes both shapes. */
  handoffDropAt?: string;
  handoffPickupAt?: string;
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

  /** Active lifecycle. `activeFrom` is the first day this driver is part
   *  of the fleet (defaults to creation date). `activeTo` is the last
   *  day — null/undefined means currently active. Both are YYYY-MM-DD
   *  strings. The calendar grid and driver pickers filter by the
   *  visible date range so retired drivers don't show up on today's
   *  view but still appear on historical loads they ran. */
  activeFrom?: string;
  activeTo?: string | null;

  /** Last time this driver made an authenticated request from the
   *  driver app. ISO timestamp. null/undefined = they've never logged
   *  in (or pre-dates the last_seen_at column). Maintained by the
   *  API's driverAuth middleware with a ~2-min in-process throttle so
   *  it's "approximately when active" not a precise heartbeat. */
  lastSeenAt?: string | null;

  /** OS-level permission status reported by the driver app on launch +
   *  AppState foreground change. 'granted' = pushes / GPS work.
   *  'denied' = user tapped Don't Allow or revoked in Settings —
   *  notifications won't reach them and GPS-stamped events won't have
   *  coords. 'undetermined' = the OS dialog has never shown; user
   *  hasn't been prompted yet. null = no report received (driver on
   *  an old bundle or never opened the app since this shipped). */
  notificationsPermission?: 'granted' | 'denied' | 'undetermined' | null;
  locationPermission?:      'granted' | 'denied' | 'undetermined' | null;
  /** Last time the driver app reported its permission state. */
  permissionsUpdatedAt?: string | null;

  /** Owner-operator flag. When true, this driver's loads are excluded
   *  from aggregate revenue reports (dashboard Total Revenue, Fleet
   *  Performance, payroll). Loads still appear in the calendar,
   *  accounting, and closeout — only the rollup math skips them.
   *  The fleet may dispatch for an owner-op without their numbers
   *  being part of the carrier's own KPIs. */
  excludeFromReports?: boolean;
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

// ── Asset (truck) documents ─────────────────────────────────────────────
//
// Same shape as DriverDocument, scoped to a single truck.
// `kind` covers the common fleet-asset paperwork:
//   - registration  : state title + plate registration
//   - inspection    : annual DOT inspection cert
//   - insurance     : insurance card / policy declaration page
//   - title         : title certificate
//   - other         : anything not in the above (IFTA permit, etc.)

export type AssetDocumentKind = 'registration' | 'inspection' | 'insurance' | 'title' | 'other';
export const ASSET_DOCUMENT_KINDS: readonly AssetDocumentKind[] = [
  'registration', 'inspection', 'insurance', 'title', 'other',
];

export interface AssetDocument {
  id:          string;
  orgId:       string;
  assetId:     number;
  kind:        AssetDocumentKind;
  fileName:    string;
  mimeType?:   string;
  sizeBytes?:  number;
  expiresOn?:  string;
  notes?:      string;
  uploadedAt:  string;
  uploadedBy:  string;
  signedUrl?:  string;
}

// ── Trailer documents ───────────────────────────────────────────────────
//
// Same shape as AssetDocument. Same five kinds — trailers have the same
// paperwork lifecycle (state registration + annual DOT inspection +
// insurance + title), just on a separate row.

export type TrailerDocumentKind = AssetDocumentKind;
export const TRAILER_DOCUMENT_KINDS: readonly TrailerDocumentKind[] = ASSET_DOCUMENT_KINDS;

export interface TrailerDocument {
  id:          string;
  orgId:       string;
  trailerId:   number;
  kind:        TrailerDocumentKind;
  fileName:    string;
  mimeType?:   string;
  sizeBytes?:  number;
  expiresOn?:  string;
  notes?:      string;
  uploadedAt:  string;
  uploadedBy:  string;
  signedUrl?:  string;
}

// ── Asset (the assets table — trucks/vehicles) ──────────────────────────

export interface Asset {
  id: number;
  name: string;
  color: string;
  type: string;
  unit?: string;
  /** Legacy free-text "Make/Model" field. Superseded by `make` +
   *  `model` below as of 2026-06-06; kept here so old UIs / clients
   *  that haven't redeployed still see something sensible. The DB
   *  column will be dropped in a follow-up migration once Curzon's
   *  data is verified clean. New code should write to `make` /
   *  `model` and ignore this. */
  truck?: string;
  /** Truck manufacturer, e.g. "Freightliner", "Peterbilt", "Kenworth". */
  make?: string;
  /** Truck model, e.g. "Cascadia", "579", "T680". */
  model?: string;
  /** 17-character Vehicle Identification Number. Used by maintenance
   *  shops + DMV lookups; indexed (org_id, vin) for fast lookup. */
  vin?: string;
  /** State-issued license plate number. Indexed for toll / DMV
   *  correspondence lookup. */
  licensePlate?: string;
  /** 2-letter US state code for the plate issuer (e.g. "CA", "IL"). */
  licenseState?: string;
  /** ISO YYYY-MM-DD expiration date for the plate / registration. */
  licenseExpiration?: string | null;
  hidden?: boolean;
  notes?: string;
  motiveVehicleId?: string;
  /** Last 4 digits of the Mudflap fuel card assigned to this truck.
   *  The Mudflap Carriers API matcher uses this as the highest-
   *  priority truck identifier because the physical card lives inside
   *  the truck — it's the only mapping that doesn't depend on the
   *  driver typing the vehicle number at the pump correctly. */
  mudflapCardLast4?: string;
  /** assets.sort_order — NOT NULL DEFAULT 0 in the DB; always present. */
  sortOrder: number;
  /** Active lifecycle. See Driver.activeFrom — same semantics. The
   *  calendar columns filter by the visible date range, so a truck
   *  retired in March still appears on the March calendar but drops
   *  out of today's view. */
  activeFrom?: string;
  activeTo?: string | null;
  /** Derived owner-operator flag. True when this asset's default driver
   *  (per driver_asset_prefs) is flagged Driver.excludeFromReports.
   *  Owner-op trucks are dispatched normally but their numbers don't
   *  roll into fleet KPIs (revenue, miles, payroll). Computed
   *  server-side in GET /v1/assets so the dashboard can filter
   *  consistently without re-deriving from a separate fetch. */
  excludeFromReports?: boolean;
}

// ── Trailer ─────────────────────────────────────────────────────────────

export interface Trailer {
  id: number;
  name: string;
  trailerNumber?: string;
  category: TrailerCategory;
  notes?: string;
  motiveVehicleId?: string;
  /** Trailer manufacturer, e.g. "Wabash", "Great Dane", "Utility". */
  make?: string;
  /** Trailer model, e.g. "DuraPlate", "Everest CL". */
  model?: string;
  /** 17-character Vehicle Identification Number. */
  vin?: string;
  /** State-issued license plate number. */
  licensePlate?: string;
  /** 2-letter US state code for the plate issuer (e.g. "CA", "IL"). */
  licenseState?: string;
  /** ISO YYYY-MM-DD expiration date for the plate / registration. */
  licenseExpiration?: string | null;
  sortOrder?: number;
  /** Active lifecycle — see Driver.activeFrom for semantics. */
  activeFrom?: string;
  activeTo?: string | null;
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
  /** When present, the inspection report this adjustment was raised from
   *  (e.g. a cleanliness "left dirty" deduction). Lets the UI mark a flag
   *  as already-deducted and prevents double-charging. */
  inspectionReportId?: string;
}

/** One driver's inspection score over a date range — how consistently they
 *  fill in inspections. Derived on demand from inspection_reports + events
 *  (active days); no stored scoring state. Cleanliness is intentionally NOT
 *  part of this (handled separately via personal follow-up + deductions).
 *  Curzon-only (Truck History gating). */
export interface DriverScore {
  driverId: number;
  driverName: string;
  activeDays: number;        // distinct days the driver had a load event
  inspectionDays: number;    // distinct days with ≥1 inspection submitted
  preTrips: number;
  postTrips: number;
  completionPct: number;     // 0–100: inspectionDays / activeDays, capped at 100
  score: number;             // 0–100 (= completionPct)
  bonusEligible: boolean;
}

/** One frozen line of a finalized pay stub.
 *
 *  Snapshotted at Finalize time into payroll_records.line_items. Each item
 *  carries everything the stub needs to be reprinted without consulting
 *  live data — that is the whole point: a stub reprinted a month later
 *  must be the same document that was issued.
 *
 *  `amount` is signed dollars (deductions negative). `id` is the source
 *  row's identity ONLY so the UI can diff a snapshot against current
 *  values; it is not a live reference and the source row may be gone. */
export interface PayrollLineItem {
  kind: "load" | "adjustment" | "accessorial";
  /** events.id / payroll_adjustments.id / "acc-<loadId>-<accessorialId>". */
  id: string;
  amount: number;
  /** Display text — event title, adjustment description, accessorial note. */
  label: string;
  /** YYYY-MM-DD. For loads this is the pickup date as it stood at finalize. */
  date?: string;
  // ── loads only ──
  eventId?: string;
  loadId?: string;
  loadNum?: string;
  /** "Leg 2 · Transfer" for relay legs; "Both" for a single-leg load. */
  legLabel?: string;
  legIndex?: number;
  legCount?: number;
  // ── adjustments / accessorials only ──
  category?: string;
}

export interface PayrollRecord {
  id: string;
  driverName: string;
  weekStart: string;
  totalPay: number;
  finalizedAt: string;
  notes?: string;
  /** The frozen detail behind `totalPay`. Absent on records finalized
   *  before the 20260728 snapshot migration and on the historical rows
   *  written by backfill-payroll-records.ts — those only ever knew a
   *  weekly total. Treat absent as "no frozen detail available", never
   *  as "zero pay": `totalPay` is still authoritative for the number. */
  lineItems?: PayrollLineItem[];
  /** Clerk user id that pressed Finalize. Authoritative. */
  finalizedBy?: string;
  /** Display label captured from the client at finalize time. Convenience
   *  for rendering; `finalizedBy` is the identity. */
  finalizedByName?: string;
  /** Set when this record stopped being in force. Records are append-only:
   *  Reopen and Re-finalize supersede rather than delete, so a week's whole
   *  payment history survives. Live records have this null. */
  supersededAt?: string;
  supersededBy?: string;
  supersededByName?: string;
  /** 'reopen'     — a human unlocked the week.
   *  'refinalize' — replaced by a fresh snapshot after the numbers changed. */
  supersededReason?: "reopen" | "refinalize";
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
  /** Default driver pay percent (0-100) used to auto-fill the Driver
   *  Pay field when Load Price is entered. null/undefined disables
   *  the auto-calc. Stored server-side so it survives clearing
   *  browser data + applies across every dispatcher's device. */
  driverPayPct?:       number | null;
  /** Per-CardFieldKey override for whether the inline icon renders on
   *  calendar event cards. Default for every key is true — so an
   *  absent entry means the icon shows. Org-wide so the team sees the
   *  same card layout. */
  cardFieldIcons?:     Record<string, boolean>;
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
  /** AR / accounting email — broker reaches out here with payment Qs.
   *  Also used as the Reply-To header on outbound invoice emails. */
  email?: string;
  /** Always-CC address for outbound invoice sends. Comma-separated
   *  emails are accepted. Common pattern: a group inbox like
   *  ar@yourcompany.com or billing@yourcompany.com so every broker
   *  reply (especially "Reply All") fans out to the AR team. Merged
   *  into the per-send CC list at the API; duplicates removed. */
  ccEmail?: string;

  // ── Email sender ────────────────────────────────────────
  /** Per-org override for the envelope From address on outbound
   *  invoice emails. Must be a real address on a domain VERIFIED
   *  with the platform's Resend account (otherwise Resend rejects
   *  the send). Leave empty to use the platform default
   *  (invoices@fleetcal.app), which is verified for every org out
   *  of the box. Orgs with their own verified domain set this to
   *  e.g. "billing@curzontrucking.com" so brokers see invoices
   *  from the carrier's actual domain. The display name on every
   *  send is always the carrier's `companyName` regardless of
   *  this field. */
  invoiceFromAddress?: string;

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

  // ── Email templating ───────────────────────────────────
  /**
   * Subject template for outbound invoice emails. Supports
   * placeholders that get substituted at send time:
   *   {{invoiceNumber}}        — one number or comma-joined for batches
   *   {{loadNumber}}           — load.load_num (the broker's load #)
   *   {{internalLoadNumber}}   — our internal load id
   *   {{brokerName}}           — broker / customer name
   *   {{companyName}}          — carrier name
   *   {{total}}                — formatted USD amount (sum for batches)
   *   {{count}}                — number of invoices in the email
   * Default: `Invoice #{{invoiceNumber}}, Load {{loadNumber}}`
   * Leave blank to use the default.
   */
  invoiceEmailSubjectTemplate?: string;
  /**
   * Plain-text body template for outbound invoice emails. Same
   * placeholders as the subject, plus:
   *   {{invoiceList}}          — multi-line block, one row per invoice
   *                              with its number / load / amount
   *   {{remitTo}}              — invoice_settings.remitToInstructions
   *   {{email}}, {{phone}}     — carrier contact (AR email, phone)
   * Default body matches the original fixed format so existing orgs
   * see no behaviour change.
   */
  invoiceEmailBodyTemplate?: string;
}

/** One row in OrgSettings.documentTypes. `kind` is a DocumentKind from
 *  @fleetcal/types/api; the union isn't imported here to avoid a circular
 *  package import — runtime validators in the API check it against the
 *  canonical enum. */
export interface DocumentTypeConfig {
  kind:           string;
  /** Surface this kind in upload pickers across all apps. */
  enabled:        boolean;
  /** Drivers can see + upload this kind. Server-enforced false for
   *  'rate_con' and 'invoice' regardless of what the client sends. */
  driverVisible:  boolean;
}

export interface OrgSettings {
  showDriverPay: boolean;
  /** Per-org rate-con AI parsing config. See RateConSettings for shape. */
  rateConSettings?: RateConSettings;
  /** Per-org invoice template + identity config. See InvoiceSettings. */
  invoiceSettings?: InvoiceSettings;
  /** Per-role capability overrides. Defaults live in
   *  @fleetcal/types/permissions ROLE_CAPABILITIES. A capability key
   *  present here for a role overrides the default — true grants,
   *  false revokes. Keys absent from the override map fall back to
   *  the hardcoded default. */
  roleOverrides?: RoleOverrides;
  /** SaaS module toggles — independent of role capabilities. A
   *  module set to `false` is OFF for the entire org (even the
   *  owner won't see the link or be able to hit the API). Missing
   *  keys default to ON so adding a new module in code is implicit-
   *  enabled until Stripe/billing flips it. See @fleetcal/types
   *  modules.ts for the enum + helper. */
  orgModules?: OrgModuleFlags;
  /** Legacy. Allow-list of DocumentKind values visible to drivers.
   *  Superseded by `documentTypes` (richer model with enable + driver-
   *  visibility flags). Kept as a server-side fallback for one release
   *  while consumers migrate. */
  driverVisibleDocKinds?: string[] | null;

  /** Per-org document-type configuration. Drives the kind pickers
   *  across web, dispatch, and driver, plus the driver-visible filter
   *  on document reads. Each entry is one row in the canonical kind
   *  list (DOCUMENT_KINDS from @fleetcal/types/api).
   *
   *  Server-enforced invariants — cannot be overridden by clients:
   *    - kind 'rate_con' always has driverVisible = false (confidential)
   *    - kind 'invoice'  always has driverVisible = false (financial)
   *
   *  Semantics:
   *    - enabled = false → kind disappears from EVERY upload picker
   *    - driverVisible = false → kind never returned by the driver app
   *      docs endpoint, even if a doc with that kind exists. Drivers
   *      also can't UPLOAD a kind that's not driver-visible (enforced
   *      at the API write boundary on /v1/driver/loads/:id/documents).
   *
   *  undefined / null → server backfills using DEFAULT_DOCUMENT_TYPES
   *  (every kind enabled; rate_con+invoice hidden from drivers, the
   *  rest visible). The 20260520 migration sets a concrete value on
   *  every existing row so this fallback is for new orgs only. */
  documentTypes?: DocumentTypeConfig[] | null;
  /** Per-org driver-notification rules. Configured by an admin in
   *  Settings → Driver App → Notifications. See @fleetcal/types
   *  notifications.ts for the shape + defaults. null/undefined ⇒
   *  server falls back to DEFAULT_NOTIFICATION_RULES at send time. */
  notificationRules?: import("./notifications").NotificationRules | null;
  /** Motive ELD integration config. The actual API key lives in a
   *  separate column (org_settings.motive_api_key) so it doesn't
   *  leak through GET /v1/org-settings; the toggles + cadences here
   *  control HOW we use the key. */
  motiveSettings?: MotiveSettings | null;
  /** Document kinds auto-included in invoice packets when a doc hasn't
   *  been explicitly toggled (e.g. ["pod","bol"]). Configured in
   *  Settings → Invoicing; stored in org_settings.invoice_auto_include_kinds.
   *  null = never configured → server falls back to
   *  DEFAULT_INVOICE_AUTO_INCLUDE_KINDS (["pod"]); [] = auto-include nothing.
   *  The SINGLE rule that consumes this (isDocIncludedInPacket, see
   *  invoicePacket.ts) is shared by the closeout UI and the server packet
   *  builder so "selected" always equals "included". */
  invoiceAutoIncludeKinds?: string[] | null;
}

/**
 * Motive integration knobs. The presence of org_settings.motive_api_key
 * (set separately) controls whether the org has Motive at all; these
 * fields tune HOW often we sync + which feeds.
 */
export interface MotiveSettings {
  /** Master switch for odometer snapshots. Defaults true when the
   *  org has a Motive key. Setting false leaves existing readings
   *  in place but stops new ones. */
  odometerSyncEnabled?: boolean;
  /** Minimum hours between odometer snapshots PER ORG. The in-process
   *  scheduler ticks hourly globally; for an org configured at e.g.
   *  4, the scheduler skips that org until 4 hours have passed since
   *  its last successful snapshot. Default: 1 (every hourly tick). */
  odometerSyncIntervalHours?: number;
  /** Master switch for driving-periods sync (calendar movement
   *  rail). Defaults true when the org has a Motive key. */
  drivingPeriodsSyncEnabled?: boolean;
  /** Minimum minutes between driving-period syncs per org. The
   *  scheduler ticks every 5 min globally; setting this to e.g. 30
   *  throttles a given org. Default: 5. */
  drivingPeriodsSyncIntervalMinutes?: number;
}


/** Per-role capability override map. Outer key is the role; inner
 *  key is the capability string (matches the Capability union in
 *  @fleetcal/types/permissions). */
export type RoleOverrides = Partial<Record<string, Record<string, boolean>>>;

/** Per-org module toggle map. Outer key is the module name (must
 *  match the OrgModule union in @fleetcal/types modules.ts). Value
 *  is a boolean — false disables the module for the org; absent or
 *  true enables it. */
export type OrgModuleFlags = Partial<Record<string, boolean>>;

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
  /**
   * Billing / remit-to address for the customer. Rendered as the
   * "Bill To" block on every invoice for this customer; if absent
   * the invoice falls back to just the customer name.
   *
   * Free-form text on purpose — Google Places autocomplete on the
   * dispatcher-facing input keeps the format clean (multi-line
   * "Knight-Swift\n2002 W Wahalla Ln\nPhoenix, AZ 85027"), but
   * AI-extracted values and legacy hand-typed values should both
   * save without validation.
   */
  billingAddress?: string;
}

// ── Dispatcher ──────────────────────────────────────────────────────────
//
// Per-org directory entry for someone who dispatches loads. Lives in the
// Manage Assets sidebar (alongside drivers/trailers/trucks/customers/
// locations). Loads reference a dispatcher row via loads.dispatcher_id;
// the legacy loads.dispatcher text column is still maintained as a
// denormalized name cache so old rows render and simple reports don't
// need the join.
//
// clerkUserId is OPTIONAL — a dispatcher row can exist without a Clerk
// account (contractor, former employee). When set, it links to a Clerk
// org member by their user_xxx ID.
//
// active is a soft-delete flag. Removing a dispatcher who has loads
// attributed to them flips active=false instead of deleting the row so
// historical attribution survives.

export interface Dispatcher {
  id: number;
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. Optional. */
  hireDate?: string;
  /** Clerk user_xxx ID when this dispatcher corresponds to a Clerk
   *  org member. Null/undefined for manually-added rows. */
  clerkUserId?: string;
  isDefault: boolean;
  active: boolean;
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
  /** Stable id of the accessorial row this change refers to. Same id
   *  across the row's full lifetime — added, any updates, removed —
   *  so a renderer can group "this row's history" if it wants. */
  id?: string;
  /** Category at the time of the change. For "added" / "removed"
   *  this is the new/snapshot category; for "updated" it's the current
   *  (post-update) category. Use prevCategory when the dispatcher
   *  switched categories. */
  category: string;
  /** Description at the time of the change (same semantics as
   *  `category`). For an "updated" entry where description itself
   *  changed, both description and prevDescription are populated. */
  description?: string;
  amount?: number;
  prevAmount?: number;
  newStatus?: string;
  prevStatus?: string;
  // ── Extended diff fields (added when more than just amount/status
  //     changed on an "updated" entry). All optional — only the pairs
  //     that actually differ get populated, so the renderer can
  //     show "amount $50 → $80 & billable on → off" cleanly without
  //     listing untouched fields. ────────────────────────────────────
  prevCategory?:      string;
  prevDescription?:   string;
  newDescription?:    string;
  prevBillable?:      boolean;
  newBillable?:       boolean;
  prevPayToDriver?:   boolean;
  newPayToDriver?:    boolean;
  prevPayDriverName?: string;
  newPayDriverName?:  string;
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
  /** Customer name (broker) free-text — when the dispatcher edits the
   *  Customer field directly. Customer-id changes (linking a load to a
   *  saved customer) carry both name + id. */
  prevBroker?: string;
  newBroker?: string;
  prevCustomerId?: string;
  newCustomerId?: string;
  /** Resolved display name for the linked customer at audit time —
   *  needed because the customers list isn't part of the audit fetch
   *  and the IDs alone aren't readable. */
  prevCustomerName?: string;
  newCustomerName?: string;
  prevDispatcher?: string;
  newDispatcher?: string;
  prevTrailerId?: number;
  newTrailerId?: number;
  /** Stored alongside the IDs for the same readability reason as
   *  customer names — the trailer list isn't fetched with the audit. */
  prevTrailerNum?: string;
  newTrailerNum?: string;
  prevPriority?: boolean;
  newPriority?: boolean;
  /** Naive ISO strings ("YYYY-MM-DDTHH:mm"); the modal renders them in
   *  the org's timezone via the same formatter as the chip strip. */
  prevStart?: string;
  newStart?: string;
  prevEnd?: string;
  newEnd?: string;
  /** Closeout / accounting transitions:
   *    pending → verified → invoiced → paid
   *  on_hold can interpose at any point. Written server-side from the
   *  closeout/invoices routes (apps/api/src/routes/closeout.ts +
   *  invoices.ts) since dispatchers don't directly edit this field. */
  prevBillingStatus?: 'pending' | 'verified' | 'invoiced' | 'paid' | 'on_hold';
  newBillingStatus?:  'pending' | 'verified' | 'invoiced' | 'paid' | 'on_hold';
  stopsAdded?: number;
  stopsRemoved?: number;
  relayCreated?: boolean;
  relayRemoved?: boolean;
  /** Leg this entry describes, when the change is leg-scoped. Without
   *  it a relay's flat pairs are ambiguous — "driver changed A → B"
   *  never said WHICH leg. The label is frozen at write time for the
   *  same reason prevCustomerName / prevTrailerNum are: the audit
   *  fetch has no leg context later, and the load's leg count may have
   *  changed since. Absent on load-level entries and on every entry
   *  written before this existed, which render exactly as before. */
  leg?: {
    /** 0-based position at the time of the change. */
    index:       number;
    /** Leg count at the time, so "Leg 2/3" stays truthful. */
    count?:      number;
    /** Frozen display label, e.g. "Leg 2 · Transfer". */
    label?:      string;
    /** Driver on that leg at the time, for readability. */
    driverName?: string;
  };
  /** Structural relay change — supersedes the relayCreated /
   *  relayRemoved booleans, which only recorded THAT a relay changed,
   *  not which handoff. Both are still written for back-compat so old
   *  readers keep working. */
  relayHandoff?: {
    action:        'added' | 'removed' | 'moved';
    /** 0-based handoff ordinal: handoff i sits between leg i and i+1. */
    index:         number;
    /** Handoff facility/address at write time. */
    location?:     string;
    prevLocation?: string;
    /** Handoff times, for action:'moved'. */
    prevDropAt?:   string;
    newDropAt?:    string;
    prevPickupAt?: string;
    newPickupAt?:  string;
    /** Leg added or removed by this change, frozen for readability. */
    legLabel?:     string;
    driverName?:   string;
  };
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
  /** The linehaul rate negotiated with the broker. UI label: "Linehaul". */
  loadPrice?: number;
  /**
   * Total billable to the broker = linehaul + billable accessorials.
   * Server-computed (loads_compute_total_billable trigger). Read-only on
   * the client — write attempts are silently overwritten by the DB.
   * UI label: "Total" (only shown when it differs from loadPrice).
   */
  totalBillable?: number;
  driverPay?: number;
  /**
   * Routed road miles on this leg, cached server-side so reports don't
   * have to re-call Google Directions. Set by the load modal when
   * calcRoadMiles resolves; cleared/recomputed whenever stops change.
   */
  loadedMiles?: number;
  /**
   * Encoded polyline (precision-5) of the driving route through this leg's
   * geocoded stops, cached server-side (Mapbox) so map views can draw the
   * route without each client calling Google Directions. Populated
   * compute-on-read by the event/load detail endpoints and self-invalidated
   * when stops change. Undefined until first computed or when <2 geocoded
   * stops. Directly usable by Google Static Maps `path=enc:`.
   */
  routePolyline?: string;
  detention?: number;
  lumperFees?: number;
  ratePerMile?: number; // legacy column
  fuelSurcharge?: number; // legacy column
  factoringCompany?: string; // legacy column
  invoiceNum?: string; // legacy column
  paymentStatus?: string; // legacy column
  /** Payroll deferral — weekStart (YYYY-MM-DD) this load's driver pay is
   *  deferred to. Pass null to the update path to CLEAR the defer
   *  (undefined would get JSON.stringify'd out of the request body and
   *  the server would treat the field as untouched). */
  deferredToWeek?: string | null;

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

  // Relay (split loads). A relay is N events sharing a load_id, ordered
  // by legIndex. relayRole is derived from position (see legRoleFor):
  // first = 'pickup', last = 'delivery', middle = 'transfer'.
  relayGroupId?: string;
  relayRole?: "pickup" | "transfer" | "delivery";
  /** 0-based position of this leg within its load. 0 for single-leg loads. */
  legIndex?: number;
  /** Total legs on this load, when the reading endpoint joined them. */
  legCount?: number;
  /** Adjacent-leg mirrors. For middle legs these describe the NEXT leg
   *  (the driver you hand off to); prev-leg context comes from the
   *  handoff stop + legs[] payloads. Pre-N-leg readers treat them as
   *  "the other leg of the pair", which stays correct for 2-leg loads. */
  partnerEventId?: string;
  partnerStops?: Stop[];
  partnerDriverName?: string;
  partnerAssetName?: string;
  /** Driver pay on the adjacent leg. Used by detail UIs that
   *  show two legs' driver pay side-by-side. */
  partnerDriverPay?: number;

  /** Trailer-drop pin saved by THIS event's driver (pickup leg only —
   *  delivery legs don't drop). Captured by the "Save Trailer Location"
   *  button on the relay handoff section of the driver app. */
  trailerDropoffLat?: number;
  trailerDropoffLng?: number;
  trailerDropoffAt?:  string;
  /** Dispatcher-set street address for the trailer drop point. This is
   *  the PRIMARY source of truth — dispatch knows the lot ahead of
   *  time; the lat/lng above is a secondary verification layer set by
   *  the driver after they've parked + dropped. */
  trailerDropoffAddress?: string;
  /** Same fields as above but mirrored from the relay partner's event.
   *  The delivery-leg driver reads these to find where the pickup-leg
   *  driver left the trailer. */
  partnerTrailerDropoffLat?:     number;
  partnerTrailerDropoffLng?:     number;
  partnerTrailerDropoffAt?:      string;
  partnerTrailerDropoffAddress?: string;

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
   * loads.deleted_at — load-row soft-delete timestamp. Distinct from
   * `deletedAt` (event-level): a cancel-keep-load drops the EVENT but
   * leaves the LOAD record alive (loadDeletedAt = null, deletedAt
   * set). A full delete drops BOTH (both set). Search results use
   * the pair to render the right status pill.
   */
  loadDeletedAt?: string;

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
  /** Customer's billing address snapshotted at invoice-generation time.
   *  Multi-line free-form text (the BrokerProfileModal collects it via
   *  Google Places autocomplete, and the rate-con AI extracts it).
   *  Rendered as the Bill To block under the broker name. */
  brokerBillingAddress?: string;
  /** @deprecated Older invoices stored the broker address split across
   *  two lines. New invoices write `brokerBillingAddress` instead;
   *  these stay readable for back-compat with archived snapshots. */
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

// ── Receivables: proofs + allocations ───────────────────────────────────
//
// Two records, deliberately separate — see migration
// 20260730_receivables.sql for the full rationale.
//
//   PaymentProof   — evidence that money moved (remittance advice, bank
//                    line, check). Stands alone; one proof routinely
//                    covers many invoices.
//   InvoicePayment — money applied to ONE invoice, optionally citing a
//                    proof. The ledger. Per-invoice amounts are entered,
//                    never prorated off the proof total.
//
// Invoice.paidAmount / paidAt are the recomputed summary of a payment's
// allocations, not an independent source of truth.

/** What kind of artifact backs the payment claim. */
export type PaymentProofKind = 'remittance' | 'bank_transaction' | 'check' | 'other';

/** How the proof entered FleetCal. `manual`/`upload` are operator
 *  actions; `csv`/`email`/`api` are reserved for ingest adapters, which
 *  must set `externalId` so re-runs are idempotent. */
export type PaymentProofSource = 'manual' | 'upload' | 'csv' | 'email' | 'api';

export type PaymentMethod = 'ach' | 'check' | 'wire' | 'factoring' | 'other';

/** Why an applied amount differs from the invoice total. Classified at
 *  allocation time so a deduction lands on the load it was taken against,
 *  rather than being smeared across every invoice in the payment. */
export type PaymentVarianceReason =
  | 'quick_pay'    // broker's early-payment discount
  | 'short_pay'    // paid less, no reason given
  | 'deduction'    // chargeback, lumper, detention dispute
  | 'overpayment'  // paid more than billed
  | 'other';

export interface PaymentProof {
  id:           string;
  orgId:        string;

  kind:         PaymentProofKind;
  source:       PaymentProofSource;

  /** Resolved payer. Absent when evidence arrived before anyone
   *  identified who sent it. */
  customerId?:  string;
  /** Payer name verbatim off the ACH descriptor or remittance header —
   *  preserved even after customerId is resolved. */
  payerRaw?:    string;

  occurredOn:   string;            // YYYY-MM-DD
  /** Total on the proof itself, which may exceed the sum applied. */
  amount:       number;
  reference?:   string;            // check no. / ACH trace / bank txn id

  // Attachment (private bucket, signed-URL reads).
  storagePath?: string;
  fileName?:    string;
  mimeType?:    string;
  sizeBytes?:   number;

  note?:        string;
  externalId?:  string;

  /** Sum of this proof's allocations. Server-computed on read; lets the
   *  UI flag a proof that isn't fully applied yet. */
  appliedAmount?: number;

  createdAt:    string;
  updatedAt:    string;
  createdBy:    string;
}

export interface InvoicePayment {
  id:              string;
  orgId:           string;
  invoiceId:       string;
  /** Null when the payment was recorded without evidence. Attachable
   *  later without touching the allocation. */
  proofId?:        string;

  /** Applied to this invoice specifically. Negative for a clawback. */
  amount:          number;
  paidOn:          string;         // YYYY-MM-DD
  method?:         PaymentMethod;
  varianceReason?: PaymentVarianceReason;
  note?:           string;

  createdAt:       string;
  updatedAt:       string;
  createdBy:       string;

  /** Denormalized proof summary, populated when the API expands it, so
   *  the invoice drawer can render evidence without a second fetch. */
  proof?:          PaymentProof;
}

/** An invoice plus its settlement state — one Receivables table row.
 *
 *  Deliberately NOT `{ invoice: Invoice }`: Invoice carries the full
 *  rendered `snapshot` jsonb, and shipping that for every row would make
 *  a 400-invoice AR list several megabytes. This is the flat projection
 *  the table actually renders; open the invoice detail for the rest.
 *
 *  `balance` and `agingDays` are computed server-side so every surface
 *  buckets identically. */
export interface ReceivableInvoice {
  id:            string;
  invoiceNumber: string;
  status:        InvoiceStatus;
  loadId:        string;

  /** FleetCal's own load sequence. invoiceNumber is derived from this,
   *  so the two are normally the same string — don't render both. */
  internalLoadId?: number;
  /** The BROKER's load number (loads.load_num) — the identifier that
   *  gets pasted into a broker portal. This is what "Load #" means to an
   *  operator, and it is NOT internalLoadId. */
  loadNum?:      string;
  /** Pickup leg's event title — the human label for the load. */
  title?:        string;
  /** Event id of the pickup leg, for opening the load in EventModal. */
  pickupEventId?: string;

  customerId?:   string;
  customerName?: string;

  total:         number;
  issuedAt:      string;
  dueAt?:        string;

  /** Sum of allocations. Mirrors invoices.paid_amount. */
  paidAmount:    number;
  balance:       number;
  /** Days past due. Negative = not yet due. Null when the invoice has no
   *  due date to measure against. */
  agingDays:     number | null;

  paymentCount:  number;
  lastPaidOn?:   string;
  /** False when no allocation cites a proof — someone marked it paid on
   *  trust and evidence was never attached. Surfaced in the table so
   *  unbacked claims are visible rather than indistinguishable. */
  hasProof:      boolean;
}

/** AR aging buckets. `current` covers anything not yet due.
 *
 *  Three buckets, not the textbook four: 31–60 and 61+ were collapsed
 *  into a single `d31_plus` because the operational decision is the
 *  same either way — past a month overdue, someone picks up the phone.
 *  Splitting it bought a column of precision nobody acted on. */
export type AgingBucket = 'current' | 'd1_30' | 'd31_plus';

export const AGING_BUCKETS: readonly AgingBucket[] = [
  'current', 'd1_30', 'd31_plus',
] as const;

export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  current:   'Current',
  d1_30:     '1–30 days',
  d31_plus:  '31+ days',
};

/** Single source of truth for bucketing. `agingDays` is days PAST due,
 *  so <= 0 means not yet due. A null (no due date) counts as current —
 *  we don't dun an invoice we never set terms on. */
export function agingBucketFor(agingDays: number | null): AgingBucket {
  if (agingDays === null || agingDays <= 0) return 'current';
  if (agingDays <= 30) return 'd1_30';
  return 'd31_plus';
}

/** Per-customer rollup — one row of the Receivables ledger.
 *
 *  Computed server-side, not in the client, so the aging figures on the
 *  bucket tiles, the per-customer aging mix, and the Age column on an
 *  expanded invoice are all derived from one implementation and cannot
 *  drift apart. */
export interface ReceivableCustomerSummary {
  customerId:   string | null;      // null = invoices with no customer set
  customerName: string;
  openCount:    number;
  openBalance:  number;
  overdueCount: number;
  overdueBalance: number;
  /** Most recent allocation date across this customer's invoices. */
  lastPaidOn?:  string;

  /** Open balance split by aging bucket. Sums to openBalance. Drives the
   *  per-customer aging mix bar and its amount chips. */
  byBucket:     Record<AgingBucket, number>;

  /** Days past due on this customer's oldest open invoice. Negative when
   *  nothing is due yet; null when they have no open invoice carrying a
   *  due date. */
  oldestAgingDays: number | null;

  /** Payment terms in days, taken as the most common (due − issued) gap
   *  across this customer's invoices rather than a stored field — the
   *  invoices are the record of what terms were actually written. Absent
   *  when no invoice carries a due date. */
  termsDays?:   number;

  /** Mean days from issue to settlement across the last year of paid
   *  invoices. How they actually pay, as opposed to termsDays, which is
   *  what they agreed to. Absent until they've paid something. */
  avgDaysToPay?: number;
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

// ── Fuel transactions (card-side) ───────────────────────────────────────
//
// The card provider (Mudflap, EFS, WEX, etc.) sends a receipt per
// fuel-up via email. A poller forwards those receipts to FleetCal via
// POST /v1/fuel-transactions/inbound-email. Each receipt becomes one
// row here.
//
// Pairs with FuelReport (driver-submitted) via fuelReportId. The
// matcher attempts to auto-link on insert; dispatch can override via
// the manual-match endpoint.

export type FuelTransactionProvider = 'mudflap' | 'efs' | 'wex' | 'comdata' | 'other';
export const FUEL_TRANSACTION_PROVIDERS: readonly FuelTransactionProvider[] = [
  'mudflap', 'efs', 'wex', 'comdata', 'other',
];

export type FuelTransactionMatchStatus =
  | 'unmatched'         // no driver report linked
  | 'auto_matched'      // matcher found a high-confidence pair
  | 'manual_matched'    // dispatcher manually linked
  | 'no_match_needed';  // dispatcher confirmed there's no driver report
export const FUEL_TRANSACTION_MATCH_STATUSES: readonly FuelTransactionMatchStatus[] = [
  'unmatched', 'auto_matched', 'manual_matched', 'no_match_needed',
];

export interface FuelTransaction {
  id:                     string;
  orgId:                  string;

  provider:               FuelTransactionProvider;
  /** Provider's own transaction id (e.g. Mudflap's "T895913162369"). */
  providerTransactionId:  string;

  /** Date-only — Mudflap receipts don't include time. */
  transactionDate:        string;
  driverName?:            string;     // short name as printed on receipt
  location?:              string;     // "Maverik #695 - American Fork, UT"
  matchedTruck?:          string;     // unit number from receipt

  /** Resolved FleetCal driver id. Set automatically when the
   *  ingest path can map driverName → drivers.name (case-insensitive
   *  substring), or manually via PATCH /:id/assign. Stays null when
   *  resolution fails — dispatcher classifies via the UI dropdown. */
  driverId?:              number;
  /** Resolved FleetCal asset id. Set automatically when matchedTruck
   *  resolves to assets.unit, or manually via PATCH /:id/assign. */
  assetId?:               number;
  /** How we know the asset_id. Set by the Mudflap sync to one of
   *  card / vehicle_number / vehicle_number_token / vin / license_plate
   *  depending on which matcher fired; set to 'report' when mirrored
   *  from a linked fuel_report; set to 'manual' on explicit dispatcher
   *  assignment. Drives the via-card pill and the cross-truck warning
   *  when re-linking. Null on rows from before the column existed. */
  assetLinkSource?:       string;

  // Diesel
  dieselGallons?:         number;
  dieselRetailPrice?:     number;
  dieselDiscountPrice?:   number;
  dieselTotal?:           number;

  // DEF
  defGallons?:            number;
  defRetailPrice?:        number;
  defDiscountPrice?:      number;
  defTotal?:              number;

  totalCharged:           number;
  totalSaved:             number;
  paymentLast4?:          string;

  // Match to a driver report
  fuelReportId?:          string;
  matchStatus:            FuelTransactionMatchStatus;
  matchConfidence?:       number;     // 0-100
  matchNotes?:            string;
  matchedAt?:             string;
  matchedBy?:             string;

  /** Set when this row was bulk-imported from the legacy my-calendar
   *  database. Holds the old fuel_form_responses.id back-pointer. */
  legacyFormResponseId?:  number;

  createdAt:              string;
  updatedAt?:             string;
}

// ── Ramp (card-spend) transactions ──────────────────────────────────────
//
// Corporate card purchases ingested from the Ramp Developer API. Unlike
// fuel_transactions (fuel-only, deterministic card→truck link), Ramp
// txns span every spend category and lean on a memo→asset matcher whose
// confidence varies with the freeform prose the team writes.

export type RampTransactionProvider = 'ramp';

export type RampTransactionMatchStatus =
  | 'unmatched'
  | 'auto_matched'
  | 'manual_matched'
  | 'not_applicable';

export type RampAssetLinkSource =
  | 'memo_unit'
  | 'memo_vin'
  | 'memo_plate'
  | 'driver_name'
  | 'nickname'
  | 'manual'
  | 'none';

export interface RampReceipt {
  receiptId?: string;
  id?:        string;
  url?:       string;
}

export interface RampTransaction {
  id:                     string;
  orgId:                  string;
  provider:               RampTransactionProvider;
  providerTransactionId:  string;

  transactedAt:           string;
  amount:                 number;
  currency:               string;
  merchantName?:          string;
  merchantCategoryCode?:  string;
  skCategoryName?:        string;
  memo?:                  string;
  receipts:               RampReceipt[];

  cardholderRampUserId?:  string;
  cardholderName?:        string;
  cardholderEmail?:       string;
  cardId?:                string;
  cardLast4?:             string;

  assetId?:               number;
  trailerId?:             number;
  assetLinkSource:        RampAssetLinkSource;

  /** UUID of the expense_bucket this txn feeds. Nullable —
   *  uncategorized txns show up on the Uncategorized CTA. */
  bucketId?:              string;
  bucketName?:            string;

  /** @deprecated superseded by bucketId. Kept for backward-compat. */
  bucketKey?:             string;
  /** @deprecated superseded by bucketId. */
  expenseCategory?:       string;

  matchStatus:            RampTransactionMatchStatus;
  matchConfidence?:       number;
  matchNotes?:            string;
  matchedAt?:             string;
  matchedBy?:             string;

  createdAt:              string;
  updatedAt?:             string;
}

// ── Recurring expenses ──────────────────────────────────────────────────
//
// Rules stored once + prorated into any reporting window at query time
// (see apps/api/src/routes/expenses.ts). New cadences (annual, quarterly)
// slot in with a cadence value + a periodDays entry in the prorater.

/** Free-text descriptive tag. The DB no longer enforces an enum — users
 *  can type any category. Bucket routing lives on `bucketKey` (8 fixed
 *  dashboard tiles). The values below are just suggestions for the UI
 *  autocomplete / starter dropdown. */
export type RecurringExpenseKind = string;

export const RECURRING_EXPENSE_KIND_SUGGESTIONS: readonly string[] = [
  'payroll_admin', 'payroll_dispatch', 'payroll_maintenance',
  'address_stipend',
  'yard_rent', 'office_rent',
  'insurance',
  'software_subscription',
] as const;

export type RecurringExpenseCadence = 'weekly' | 'monthly';

export interface RecurringExpense {
  id:             string;
  orgId:          string;
  /** UUID of the expense_bucket this rule feeds. */
  bucketId:       string;
  /** Denormalized bucket name for UI display (populated by API). */
  bucketName?:    string;
  /** Optional descriptive tag the user picks. */
  kind?:          string;
  label:          string;
  amount:         number;
  cadence:        RecurringExpenseCadence;
  effectiveFrom:  string;    // YYYY-MM-DD
  effectiveTo?:   string;    // YYYY-MM-DD (nullable = open-ended)
  notes?:         string;
  createdAt:      string;
  updatedAt:      string;
}

/** Ramp card sub-categorization. Drives which /expenses bucket a card
 *  txn feeds. 'office' is treated as overhead — not surfaced on the
 *  primary tiles. 'other' + null are equivalent from a bucket-routing
 *  standpoint but differ intent (other = "I looked at it and it's
 *  none of the above"; null = "not yet reviewed"). */
export type RampExpenseCategory =
  | 'maintenance'
  | 'load_expenses'
  | 'hotels'
  | 'fuel'
  | 'office'
  | 'other';

export const RAMP_EXPENSE_CATEGORIES: readonly RampExpenseCategory[] = [
  'maintenance', 'load_expenses', 'hotels', 'fuel', 'office', 'other',
] as const;

// ── One-time expense entries ────────────────────────────────────────────
//
// Ad-hoc / one-off charges that don't fit the recurring-rules model
// (variable weekly amounts, unpredictable cadence, or truly one-off).
// Manual entry — no integration for now. See expense_entries table.

/** Free-text descriptive tag. DB no longer enforces an enum. */
export type ExpenseEntryKind = string;

export const EXPENSE_ENTRY_KIND_SUGGESTIONS: readonly string[] = [
  'owner_op_payout', 'claim_payout', 'truck_purchase', 'equipment_purchase',
  'tax', 'owner_draw', 'subscription', 'misc',
] as const;

export interface ExpenseEntry {
  id:          string;
  orgId:       string;
  bucketId:    string;
  bucketName?: string;
  kind?:       string;
  date:        string;   // YYYY-MM-DD
  amount:      number;
  label:       string;
  notes?:      string;
  createdAt:   string;
  updatedAt:   string;
}

// ── Ramp category rules (user-editable auto-map) ────────────────────────

/** Extra condition on an auto-file rule: what the memo matcher must
 *  have resolved on the txn for the rule to fire. 'any' ignores the
 *  asset link (default); 'none' fires only when NO unit was matched. */
export type RampRuleAssetScope = 'any' | 'truck' | 'trailer' | 'none';

export interface RampCategoryRule {
  id:          string;
  orgId:       string;
  pattern:     string;
  isRegex:     boolean;
  bucketId:    string;
  bucketName?: string;
  assetScope:  RampRuleAssetScope;
  priority:    number;
  notes?:      string;
  createdAt:   string;
  updatedAt:   string;
}

// ── Expense buckets (user-editable tree) ────────────────────────────────
//
// The dashboard tile structure is now data, not code. Each org owns a
// 2-level tree of buckets — top-level buckets become dashboard tiles,
// sub-buckets show up in drill-in views. Users add/rename/reorder/
// delete freely.

/** Auto-injection markers. Any bucket (top-level or sub) can carry
 *  one — sub-bucket amounts roll up into the parent tile. The API
 *  routes driver_pay + payroll_adjustments into whichever bucket has
 *  'driver_pay', and fuel_transactions into whichever has
 *  'mudflap_fuel'. Assigning a role moves it off the previous holder. */
export type ExpenseBucketSystemRole = 'driver_pay' | 'mudflap_fuel';

export const EXPENSE_BUCKET_SYSTEM_ROLES: readonly ExpenseBucketSystemRole[] = [
  'driver_pay', 'mudflap_fuel',
] as const;

/** One row in the expense_buckets table. Flat shape — the tree is
 *  reconstructed client-side (or in the /buckets/tree endpoint) via
 *  parentBucketId. */
export interface ExpenseBucket {
  id:              string;
  orgId:           string;
  parentBucketId?: string;
  name:            string;
  icon?:           string;    // lucide-react icon name
  color?:          string;
  sortOrder:       number;
  systemRole?:     ExpenseBucketSystemRole;
  createdAt:       string;
  updatedAt:       string;
}

/** Tree-shaped bucket for UI rendering — a top-level bucket + its
 *  ordered children. */
export interface ExpenseBucketTreeNode {
  bucket:   ExpenseBucket;
  children: ExpenseBucket[];   // sorted by sortOrder
}

// ── Backward-compat exports ────────────────────────────────────────────
//
// The old 8-key enum has been retired at the DB level. These exports
// remain as free-text `string` for anything typed against the old
// literal union, so callers that still refer to ExpenseBucketKey
// compile against a superset (any string).

/** @deprecated buckets are now user-editable data. Use ExpenseBucket['id'] (uuid). */
export type ExpenseBucketKey = string;

// ── Maintenance ─────────────────────────────────────────────────────────
//
// Two-layer model:
//   - MaintenanceReport      — driver-submitted raw input. Immutable
//                              once filed (only `status` changes via ops
//                              triage).
//   - MaintenanceActionItem  — ops's tracked work. Created from a report
//                              (reportId set) or ad-hoc.

/** Triage state of a driver-submitted report.
 *
 *  'reviewed' is LEGACY and means exactly what 'dismissed' means. The
 *  web app wrote 'dismissed' ("Ignore") while the dispatch app wrote
 *  'reviewed' ("Mark reviewed") for the same human action, and the two
 *  disagreed on whether the result was still pending. As of
 *  20260726_maintenance_report_status_unify.sql the two are collapsed:
 *  'dismissed' is the only value new clients write, and both mean
 *  "settled, no longer pending".
 *
 *  The value stays in the union — and therefore in the API's PATCH
 *  allow-list — because dispatch builds already on drivers' phones can
 *  still send it. Every UI must render it identically to 'dismissed'. */
export type MaintenanceReportStatus = 'open' | 'reviewed' | 'dismissed' | 'converted';
export const MAINTENANCE_REPORT_STATUSES: readonly MaintenanceReportStatus[] = [
  'open', 'reviewed', 'dismissed', 'converted',
];

/** True when a report still needs dispatcher attention. The single
 *  source of truth for "pending" across every surface — 'reviewed' and
 *  'dismissed' are both settled, 'converted' became a work order. */
export function isMaintenanceReportPending(status: string): boolean {
  return status === 'open';
}

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

  /** 'driver' for a standalone report; 'inspection' when spawned from a
   *  failed inspection item (step 3 of the pre/post-trip flow). */
  source:         'driver' | 'inspection';
  /** When source='inspection', the originating inspection + checklist item. */
  inspectionReportId?: string;
  inspectionItemId?:   string;

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

  /** Linked calendar event — denormalized "primary / most-recently-
   *  linked" hint for back-compat. The canonical multi-link list is
   *  `eventIds` below. Many work orders can share one event ("in the
   *  shop Tuesday" covering brakes + DOT + trans flush), and now one
   *  work order can also span multiple events (deferred from
   *  Tuesday's block into Friday's). Cleared automatically when the
   *  underlying event is deleted — the WO survives, just unscheduled. */
  eventId?:      string;
  /** Full set of linked event ids. Populated server-side from the
   *  maintenance_action_item_events join table. Empty (or absent) =
   *  not scheduled into any block. Read by the calendar bucketing on
   *  the maintenance board so a WO can sit on multiple days. */
  eventIds?:     string[];
  /** Same set as `eventIds` but denormalized with each event's start
   *  timestamp so the maintenance board can position the WO on the
   *  right day(s) without a second fetch. Sorted oldest-first.
   *  Server-side join — UI treats it as read-only. */
  linkedEvents?: Array<{ id: string; start: string }>;

  completedAt?:     string;
  completedBy?:     string;
  /** Resolved display name for the completer — populated from Clerk
   *  when the dispatcher marks the item done, or set to the
   *  free-text vendor / mechanic name when the form's "Completed by"
   *  field was used. UI prefers this over the raw completedBy id. */
  completedByName?: string;

  // Phase-2 slots, exposed but typically empty in Phase 1.
  vendor?:        string;
  estimatedCost?: number;
  actualCost?:    number;

  createdBy:      string;
  /** Resolved display name for the creator — backfilled from Clerk on
   *  insert so the dispatcher UI's Activity panel reads "Created … by
   *  Matt Curzon" instead of the raw Clerk user_id. May be absent on
   *  legacy rows created before the migration; UI should fall back
   *  gracefully. */
  createdByName?: string;
  createdAt:      string;
  updatedAt:      string;

  /** Dispatcher-uploaded photos attached directly to this work order.
   *  Distinct from the linked driver report's photos (those live on
   *  the report and are inherited via reportId). Populated by list/
   *  detail endpoints that pre-fetch from maintenance_action_item_photos. */
  photos?:        MaintenanceActionItemPhoto[];
}

export interface MaintenanceActionItemPhoto {
  id:           string;
  actionItemId: string;
  fileName:     string;
  mimeType?:    string;
  sizeBytes?:   number;
  uploadedBy?:  string;
  uploadedAt:   string;
  /** Signed read URL minted server-side; expires after ~1 hour. */
  signedUrl?:   string;
}


// ── Load notifications (dispatcher → driver nudge timeline) ────────────

export type LoadNotificationKind =
  | 'confirm'
  | 'mark_pickup'
  | 'mark_delivery'
  | 'upload_pod'
  | 'report_trailer'
  // Relay-specific: driver dropped the trailer at the relay handoff
  // point, dispatcher prompts them to upload photos + pin the spot.
  // Surfaced only for relay PICKUP legs (the leg ending at the
  // handoff). Acks when a relay_handoff document gets uploaded.
  | 'upload_handoff'
  // Informational — driver doesn't need to act. Cleared from the
  // pending badge when the driver opens the bell (mark-viewed).
  | 'assigned'
  | 'reassigned_away'
  | 'load_cancelled';

export const LOAD_NOTIFICATION_KINDS: readonly LoadNotificationKind[] = [
  'confirm', 'mark_pickup', 'mark_delivery', 'upload_pod', 'report_trailer',
  'upload_handoff',
  'assigned', 'reassigned_away', 'load_cancelled',
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
