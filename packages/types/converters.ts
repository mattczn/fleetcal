/**
 * DB row ↔ app domain converters.
 *
 * As of Phase 2.5a, the schema is bilingual:
 *   • Old shape — load-level fields denormalized on `events` row. Used by
 *     `dbEventToApp` / `appEventToDb` (kept for not-yet-migrated callers).
 *   • New shape — `loads` row + `events` row joined via `events.load_id`.
 *     Used by `joinEventLoadToApp` and the split-write helpers
 *     `appLoadToEventInsert` / `appLoadToLoadInsert`.
 *
 * Apps migrate from old to new converters one-by-one. Once all apps are on
 * the new path, the old converters and their underlying event columns get
 * dropped (Phase 2.5c).
 */

import type { Database, Json } from "./database";
import type {
  Load,
  Accessorial,
  LoadAuditEntry,
  RefNum,
} from "./domain";
import type { LoadStatus, RelayRole, EventKind } from "./enums";

type EventRow      = Database["public"]["Tables"]["events"]["Row"];
type EventInsert   = Database["public"]["Tables"]["events"]["Insert"];
type LoadDbRow     = Database["public"]["Tables"]["loads"]["Row"];
type LoadDbInsert  = Database["public"]["Tables"]["loads"]["Insert"];

// Legacy aliases for the old denormalized-event converters
type LoadRow    = EventRow;
type LoadInsert = EventInsert;

/**
 * Converter input type. The generated `LoadRow` and the older hand-written
 * `DbEvent` interface in apps/web/lib/supabase.ts have drifted in nullability
 * and JSON-column annotations. Typing this as `any` lets either feed in
 * cleanly without forcing call-site casts; the function body re-narrows
 * each field to its known type as it builds the app-domain Load.
 *
 * `any` is intentional here: this is the type boundary between two
 * source-of-truth row shapes that we can't yet unify (the hand-written
 * Db* types live to die in a follow-up sweep).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadRowInput = any;

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * `events.ref_nums` is stored as text. Historically it has held three formats:
 *   - JSON array of `{label, value}` (current)
 *   - JSON array of strings           (older)
 *   - comma-separated string          (oldest)
 * This parser handles all three so a long-lived event still reads cleanly.
 */
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

// ── DB row → app domain ─────────────────────────────────────────────────

export function dbEventToApp(row: LoadRowInput): Load {
  // The body asserts each access since LoadRowInput is intentionally loose.
  const r = row as Record<string, unknown>;
  return {
    id:                  r.id as string,
    internalLoadId:      (r.internal_load_id as number | null) ?? undefined,
    assetId:             r.asset_id as number,
    title:               r.title as string,
    start:               r.start as string,
    end:                 r.end as string,
    driverName:          (r.driver_name as string | null)        ?? undefined,
    driverId:            (r.driver_id as number | null)          ?? undefined,
    status:              (r.status as LoadStatus | null)         ?? "scheduled",
    relayGroupId:        (r.relay_group_id as string | null)     ?? undefined,
    relayRole:           (r.relay_role as RelayRole | null)      ?? undefined,
    loadNum:             (r.load_num as string | null)           ?? undefined,
    refNums:             parseRefNums(r.ref_nums as string | null | undefined),
    broker:              (r.broker as string | null)             ?? undefined,
    trailerType:         (r.trailer_type as string | null)       ?? undefined,
    trailerId:           (r.trailer_id as number | null)         ?? undefined,
    dispatcher:          (r.dispatcher as string | null)         ?? undefined,
    loadPrice:           (r.load_price as number | null)         ?? undefined,
    driverPay:           (r.driver_pay as number | null)         ?? undefined,
    specialInstructions: (r.special_instructions as string | null) ?? undefined,
    notes:               (r.notes as string | null)              ?? undefined,
    rateConPdf:          (r.rate_con_pdf as string | null)       ?? undefined,
    accessorials:        (r.accessorials as Accessorial[] | null | undefined) ?? undefined,
    priority:            (r.priority as boolean | null)          ?? undefined,
    eventKind:           ((r.event_kind as EventKind | null) ?? "revenue") as EventKind,
    nonRevenueType:      (r.non_revenue_type as string | null)   ?? undefined,
    createdByName:       (r.created_by_name as string | null)    ?? undefined,
    createdAt:           (r.created_at as string | null)         ?? undefined,
    auditLog:            (r.audit_log as LoadAuditEntry[] | null | undefined) ?? undefined,
    stops:               [], // empty by default; callers populate via fetchStopsForEvents
  };
}

// ── App domain → DB insert ──────────────────────────────────────────────

// Re-exported helper so apps can call it without re-implementing.
export { parseRefNums };

// ─────────────────────────────────────────────────────────────────────────
// NEW (Phase 2.5b) — join-aware converters for split loads + events schema
// ─────────────────────────────────────────────────────────────────────────

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
    driverId:       (e.driver_id as number | null) ?? undefined,
    driverName:     (e.driver_name as string | null) ?? undefined,
    eventKind:      ((e.event_kind as EventKind | null) ?? "revenue") as EventKind,
    nonRevenueType: (e.non_revenue_type as string | null) ?? undefined,
    relayRole:      (e.relay_role as RelayRole | null) ?? undefined,
    trailerId:      (e.trailer_id as number | null) ?? undefined,
    trailerType:    (e.trailer_type as string | null) ?? undefined,
    driverPay:      (e.driver_pay as number | null) ?? undefined,
    eventNotes:     (e.notes as string | null) ?? undefined,
    priority:       (e.priority as boolean | null) ?? false,
    createdAt:      (e.created_at as string | null) ?? undefined,

    // ── Load-level (from loads row when revenue, else undefined) ────────
    loadId:         (l?.id as string | undefined) ?? undefined,
    internalLoadId: (l?.internal_load_id as number | undefined) ?? undefined,
    loadNum:        (l?.load_num as string | null | undefined) ?? undefined,
    broker:         (l?.broker as string | null | undefined) ?? undefined,
    customerId:     (l?.customer_id as string | null | undefined) ?? undefined,
    dispatcher:     (l?.dispatcher as string | null | undefined) ?? undefined,
    createdByName:  (l?.created_by_name as string | null | undefined) ?? undefined,
    loadPrice:      (l?.load_price as number | null | undefined) ?? undefined,
    rateConPdf:     (l?.rate_con_pdf as string | null | undefined) ?? undefined,
    accessorials:   (l?.accessorials as Accessorial[] | null | undefined) ?? undefined,
    refNums:        parseRefNums(l?.ref_nums as string | null | undefined),
    notes:          (l?.notes as string | null | undefined) ?? undefined,
    auditLog:       (l?.audit_log as LoadAuditEntry[] | null | undefined) ?? undefined,

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
    rate_con_pdf:     load.rateConPdf      ?? null,
    accessorials:     (load.accessorials ?? null) as unknown as Json | null,
    ref_nums:         load.refNums?.length ? JSON.stringify(load.refNums) : null,
    notes:            load.notes           ?? null, // load-level notes
    audit_log:        (load.auditLog ?? null) as unknown as Json | null,
  } as LoadDbInsert;
}

// Internal types for the join converter — both intentionally loose at this
// boundary, same rationale as `LoadRowInput` below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventRowInput = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoadDbRowInput = any;

// ─────────────────────────────────────────────────────────────────────────
// LEGACY (pre-2.5a) — denormalized event-row → app converters
// ─────────────────────────────────────────────────────────────────────────

export function appEventToDb(
  ev: Omit<Load, "id">,
  orgId: string,
  id?: string,
): LoadInsert {
  // The generated type marks `internal_load_id` as required, but the live DB
  // populates it via a default/trigger — existing inserts have always worked
  // without supplying one. The cast bypasses the spurious requirement.
  return {
    id:                   id ?? crypto.randomUUID(),
    org_id:               orgId,
    asset_id:             ev.assetId,
    title:                ev.title,
    start:                ev.start,
    end:                  ev.end,
    driver_name:          ev.driverName          ?? null,
    driver_id:            ev.driverId            ?? null,
    status:               ev.status              ?? "scheduled",
    relay_group_id:       ev.relayGroupId        ?? null,
    relay_role:           ev.relayRole           ?? null,
    load_num:             ev.loadNum             ?? null,
    ref_nums:             ev.refNums?.length ? JSON.stringify(ev.refNums) : null,
    broker:               ev.broker              ?? null,
    trailer_type:         ev.trailerType         ?? null,
    trailer_id:           ev.trailerId           ?? null,
    dispatcher:           ev.dispatcher          ?? null,
    load_price:           ev.loadPrice           ?? null,
    driver_pay:           ev.driverPay           ?? null,
    special_instructions: ev.specialInstructions ?? null,
    notes:                ev.notes               ?? null,
    rate_con_pdf:         ev.rateConPdf          ?? null,
    // Accessorial[] / LoadAuditEntry[] are structurally JSON-compatible at runtime
    // but TypeScript can't prove it (Json's index signature requires `[k: string]: Json`).
    accessorials:         (ev.accessorials ?? null) as unknown as Json | null,
    priority:             ev.priority            ?? false,
    event_kind:           ev.eventKind           ?? "revenue",
    non_revenue_type:     ev.nonRevenueType      ?? null,
    created_by_name:      ev.createdByName       ?? null,
    audit_log:            (ev.auditLog ?? null) as unknown as Json | null,
    deleted_at:           null,
  } as LoadInsert;
}
