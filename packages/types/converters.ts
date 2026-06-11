/**
 * DB row ↔ app domain converters.
 *
 * Schema (post-2.5c): `loads` row + `events` row joined via
 * `events.load_id`. `joinEventLoadToApp` reads the joined shape into the
 * app-domain `Load` view; `appLoadToEventInsert` / `appLoadToLoadInsert`
 * write the corresponding tables.
 */

import type { Database, Json } from "./database";
import type {
  Load,
  Accessorial,
  InternalNote,
  LoadAuditEntry,
  LoadFollowUp,
  RefNum,
} from "./domain";
import type { LoadStatus, RelayRole, EventKind } from "./enums";

type EventInsert   = Database["public"]["Tables"]["events"]["Insert"];
type LoadDbInsert  = Database["public"]["Tables"]["loads"]["Insert"];

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * `loads.ref_nums` is stored as text. Historically it has held three formats:
 *   - JSON array of `{label, value}` (current)
 *   - JSON array of strings           (older)
 *   - comma-separated string          (oldest)
 * This parser handles all three so a long-lived load still reads cleanly.
 */
// Reads the joined asset embed off an event row when the calling
// endpoint included `asset:assets(name, unit)` in its select.
// Returns "Name #Unit" / "Name" / undefined based on what's present.
// Tolerates PostgREST shapes: foreign-key join returns either an
// object or an array depending on cardinality declaration.
function readJoinedAssetName(e: Record<string, unknown>): string | undefined {
  const raw = (e as { asset?: unknown }).asset;
  if (!raw) return undefined;
  const a = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined) : (raw as Record<string, unknown>);
  if (!a) return undefined;
  const name = (a.name as string | null | undefined) ?? undefined;
  const unit = (a.unit as string | null | undefined) ?? undefined;
  if (!name) return undefined;
  return unit ? `${name} #${unit}` : name;
}

function parseRefNums(raw: string | null | undefined): RefNum[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === "object" && parsed[0] !== null && "label" in parsed[0]) {
        return parsed as RefNum[];
      }
      // Old format: string[] — migrate on read
      return (parsed as string[])
        .filter(Boolean)
        .map((v) => ({ label: "", value: String(v) }));
    }
  } catch {
    /* fall through to legacy comma-separated */
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => ({ label: "", value: v }));
}

export { parseRefNums };

/**
 * Join an `events` row with its `loads` row (or null for non-revenue) into
 * the app-domain `Load` view.
 *
 * Use this for read paths that select events with nested load via PostgREST:
 *   .from('events').select('*, load:loads(*)')...
 */
export function joinEventLoadToApp(
  eventRow: EventRowInput,
  loadRow: LoadDbRowInput | null | undefined,
): Load {
  const e = eventRow as Record<string, unknown>;
  const l = (loadRow ?? null) as Record<string, unknown> | null;
  return {
    // ── Event-level (always from event row) ─────────────────────────────
    id:             e.id as string,
    title:          e.title as string,
    start:          e.start as string,
    end:            e.end as string,
    status:         ((e.status as LoadStatus | null) ?? "scheduled") as LoadStatus,
    assetId:        e.asset_id as number,
    // assetName comes from the joined asset:assets(name, unit) embed
    // when the calling endpoint includes it (e.g. /v1/events/:id).
    // Falls back to undefined when the join is absent so callers that
    // didn't ask for it don't accidentally get partial data — the
    // dispatch mobile and web UIs both display `load.assetName` for
    // the truck label and were rendering blank without this wiring.
    assetName:      readJoinedAssetName(e),
    driverId:       (e.driver_id as number | null) ?? undefined,
    driverName:     (e.driver_name as string | null) ?? undefined,
    eventKind:      ((e.event_kind as EventKind | null) ?? "revenue") as EventKind,
    nonRevenueType: (e.non_revenue_type as string | null) ?? undefined,
    relayRole:      (e.relay_role as RelayRole | null) ?? undefined,
    trailerId:      (e.trailer_id as number | null) ?? undefined,
    trailerType:    (e.trailer_type as string | null) ?? undefined,
    driverPay:      (e.driver_pay as number | null) ?? undefined,
    loadedMiles:    (e.loaded_miles as number | null) ?? undefined,
    eventNotes:     (e.notes as string | null) ?? undefined,
    priority:       (e.priority as boolean | null) ?? false,
    createdAt:      (e.created_at as string | null) ?? undefined,
    deletedAt:      (e.deleted_at as string | null) ?? undefined,
    auditLog:       (e.audit_log as LoadAuditEntry[] | null | undefined) ?? undefined,
    confirmedAt:           (e.confirmed_at as string | null) ?? undefined,
    confirmedBy:           (e.confirmed_by as number | null) ?? undefined,
    confirmReminderSentAt: (e.confirm_reminder_sent_at as string | null) ?? undefined,
    trailerDropoffLat:     (e.trailer_dropoff_lat as number | null) ?? undefined,
    trailerDropoffLng:     (e.trailer_dropoff_lng as number | null) ?? undefined,
    trailerDropoffAt:      (e.trailer_dropoff_at  as string | null) ?? undefined,
    trailerDropoffAddress: (e.trailer_dropoff_address as string | null) ?? undefined,

    // ── Load-level (from loads row when revenue, else undefined) ────────
    loadId:         (l?.id as string | undefined) ?? undefined,
    internalLoadId: (l?.internal_load_id as number | null | undefined) ?? undefined,
    loadNum:        (l?.load_num as string | null | undefined) ?? undefined,
    broker:         (l?.broker as string | null | undefined) ?? undefined,
    customerId:     (l?.customer_id as string | null | undefined) ?? undefined,
    dispatcher:     (l?.dispatcher as string | null | undefined) ?? undefined,
    createdByName:  (l?.created_by_name as string | null | undefined) ?? undefined,
    loadPrice:      (l?.load_price as number | null | undefined) ?? undefined,
    // Server-computed: linehaul + billable accessorials.
    // Maintained by the loads_compute_total_billable BEFORE trigger
    // (see 20260605_loads_total_billable.sql). Never written from the
    // client — appLoadToLoadInsert deliberately omits it.
    totalBillable:  (l?.total_billable as number | null | undefined) ?? undefined,
    commodity:      (l?.commodity as string | null | undefined) ?? undefined,
    weight:         (l?.weight as number | null | undefined) ?? undefined,
    rateConPdf:     (l?.rate_con_pdf as string | null | undefined) ?? undefined,
    accessorials:   (l?.accessorials as Accessorial[] | null | undefined) ?? undefined,
    refNums:        parseRefNums(l?.ref_nums as string | null | undefined),
    notes:          (l?.notes as string | null | undefined) ?? undefined,
    internalNotes:  Array.isArray(l?.internal_notes)
                      ? (l!.internal_notes as InternalNote[])
                      : [],
    // Billing workflow
    billingStatus:  (l?.billing_status as Load['billingStatus'] | undefined) ?? undefined,
    flaggedReason:  (l?.flagged_reason as string | null | undefined) ?? undefined,
    flaggedNote:    (l?.flagged_note   as string | null | undefined) ?? undefined,
    flaggedAt:      (l?.flagged_at     as string | null | undefined) ?? undefined,
    flaggedBy:      (l?.flagged_by     as string | null | undefined) ?? undefined,
    verifiedAt:     (l?.verified_at    as string | null | undefined) ?? undefined,
    verifiedBy:     (l?.verified_by    as string | null | undefined) ?? undefined,
    invoiceDocIds:  Array.isArray(l?.invoice_doc_ids)
                      ? (l!.invoice_doc_ids as string[])
                      : [],
    followUps:      Array.isArray(l?.follow_ups)
                      ? (l!.follow_ups as LoadFollowUp[])
                      : [],
    isTonu:         (l?.is_tonu as boolean | null | undefined) ?? false,
    // Denormalized doc counts (POD, BOL, etc.) maintained by the
    // load_documents_refresh_counts trigger. Drives the green
    // doc-icon overlay on calendar cards. Stored as jsonb so any
    // doc kind can have its own icon without a schema change. Empty
    // object means no docs; the UI treats {} the same as missing.
    // Skip attaching when empty to keep the wire payload lean.
    documentCounts: (l && l.document_counts && typeof l.document_counts === 'object' && Object.keys(l.document_counts as Record<string, number>).length > 0)
                      ? (l.document_counts as Record<string, number>)
                      : undefined,
    // Load-row soft-delete timestamp. Distinct from `deletedAt`
    // (event-level) — a cancelled-keep-load has the EVENT deleted
    // but the LOAD alive; a full delete has both. Search-result
    // status pills use both flags to label the row.
    loadDeletedAt:  (l?.deleted_at as string | null | undefined) ?? undefined,
    // relayGroupId aliases loadId for relay legs. Two events with the same
    // load_id and relay_role set ARE the relay; the alias keeps existing
    // relayGroupId-reading code working. Pre-2.5c, fall back to the
    // legacy column for events that haven't been backfilled (defensive).
    relayGroupId:   (e.relay_role && l?.id)
                      ? (l.id as string)
                      : (e.relay_group_id as string | null | undefined) ?? undefined,

    stops: [], // populated separately by the stops fetch
  };
}

/**
 * Extract event-table fields from a Load. Used by mutations that write to
 * `events` only (start/end edits, asset reassignment, status changes,
 * driver changes — anything per-leg).
 */
export function appLoadToEventInsert(
  load: Omit<Load, "id">,
  orgId: string,
  id?: string,
): EventInsert {
  return {
    id:               id ?? crypto.randomUUID(),
    org_id:           orgId,
    load_id:          load.loadId ?? null,
    asset_id:         load.assetId,
    title:            load.title,
    start:            load.start,
    end:              load.end,
    driver_id:        load.driverId ?? null,
    driver_name:      load.driverName ?? null,
    status:           load.status ?? "scheduled",
    event_kind:       load.eventKind ?? "revenue",
    non_revenue_type: load.nonRevenueType ?? null,
    relay_role:       load.relayRole ?? null,
    trailer_id:       load.trailerId ?? null,
    trailer_type:     load.trailerType ?? null,
    driver_pay:       load.driverPay ?? null,
    loaded_miles:     load.loadedMiles ?? null,
    notes:            load.eventNotes ?? null, // event-level notes
    priority:         load.priority ?? false,
    deleted_at:       null,
  } as EventInsert;
}

/**
 * Extract loads-table fields from a Load. Used by mutations that write to
 * `loads` only (broker/rate/accessorials/etc. — anything load-level).
 *
 * For new loads, omit `loadId` — the DB generates the uuid and the trigger
 * allocates `internal_load_id`.
 */
/** Coerce a weight value to a non-negative integer for `loads.weight`
 *  (column type is `integer`). Brokers sometimes print "33,309.6" or
 *  similar — the AI parser passes it straight through, which Postgres
 *  rejects with `invalid input syntax for type integer`. We round
 *  instead of failing the whole load insert. Returns null for
 *  unparseable / blank input. */
function coerceWeightToInt(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export function appLoadToLoadInsert(
  load: Partial<Load>,
  orgId: string,
  loadId?: string,
): LoadDbInsert {
  return {
    ...(loadId ? { id: loadId } : {}),
    org_id:           orgId,
    load_num:         load.loadNum         ?? null,
    broker:           load.broker          ?? null,
    customer_id:      load.customerId      ?? null,
    dispatcher:       load.dispatcher      ?? null,
    created_by_name:  load.createdByName   ?? null,
    load_price:       load.loadPrice       ?? null,
    commodity:        load.commodity       ?? null,
    weight:           coerceWeightToInt(load.weight),
    rate_con_pdf:     load.rateConPdf      ?? null,
    accessorials:     (load.accessorials ?? null) as unknown as Json | null,
    ref_nums:         load.refNums?.length ? JSON.stringify(load.refNums) : null,
    notes:                 load.notes               ?? null, // load-level notes
    internal_notes:        (load.internalNotes ?? []) as unknown as Json,
    audit_log:        (load.auditLog ?? null) as unknown as Json | null,
  } as LoadDbInsert;
}

// Internal types for the join converter — both intentionally loose at this
// boundary; the function body re-narrows each field as it's read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventRowInput = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadDbRowInput = any;
