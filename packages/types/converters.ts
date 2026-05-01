/**
 * DB row ↔ app domain converters.
 *
 * Currently exposes the Load (events) converters that are needed by all three
 * apps. Asset/Driver/Trailer/Stop converters still live in
 * apps/web/lib/supabase.ts and will move here in a follow-up — they have
 * dependencies (notably normalizePhone for appDriverToDb) that need to be
 * unwound first.
 */

import type { Database, Json } from "./database";
import type {
  Load,
  Accessorial,
  LoadAuditEntry,
  RefNum,
} from "./domain";
import type { LoadStatus, RelayRole, EventKind } from "./enums";

type LoadRow = Database["public"]["Tables"]["events"]["Row"];
type LoadInsert = Database["public"]["Tables"]["events"]["Insert"];

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
    status:              (r.status as LoadStatus | null)         ?? undefined,
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
    stops:               undefined, // populated separately
  };
}

// ── App domain → DB insert ──────────────────────────────────────────────

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
