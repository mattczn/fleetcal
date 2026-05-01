/**
 * DB row ↔ app domain converters.
 *
 * Currently exposes the Load (events) converters that are needed by all three
 * apps. Asset/Driver/Trailer/Stop converters still live in
 * apps/web/lib/supabase.ts and will move here in a follow-up — they have
 * dependencies (notably normalizePhone for appDriverToDb) that need to be
 * unwound first.
 */

import type { Database } from "./database";
import type {
  Load,
  Accessorial,
  LoadAuditEntry,
  RefNum,
} from "./domain";
import type { LoadStatus, RelayRole, EventKind } from "./enums";

type LoadRow = Database["public"]["Tables"]["events"]["Row"];
type LoadInsert = Database["public"]["Tables"]["events"]["Insert"];

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * `events.ref_nums` is stored as text. Historically it has held three formats:
 *   - JSON array of `{label, value}` (current)
 *   - JSON array of strings           (older)
 *   - comma-separated string          (oldest)
 * This parser handles all three so a long-lived event still reads cleanly.
 */
function parseRefNums(raw: string | null): RefNum[] | undefined {
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

export function dbEventToApp(row: LoadRow): Load {
  return {
    id:                  row.id,
    internalLoadId:      row.internal_load_id ?? undefined,
    assetId:             row.asset_id,
    title:               row.title,
    start:               row.start,
    end:                 row.end,
    driverName:          row.driver_name        ?? undefined,
    driverId:            row.driver_id          ?? undefined,
    status:              (row.status as LoadStatus) ?? undefined,
    relayGroupId:        row.relay_group_id     ?? undefined,
    relayRole:           (row.relay_role as RelayRole) ?? undefined,
    loadNum:             row.load_num           ?? undefined,
    refNums:             parseRefNums(row.ref_nums),
    broker:              row.broker             ?? undefined,
    trailerType:         row.trailer_type       ?? undefined,
    trailerId:           row.trailer_id         ?? undefined,
    dispatcher:          row.dispatcher         ?? undefined,
    loadPrice:           row.load_price         ?? undefined,
    driverPay:           row.driver_pay         ?? undefined,
    specialInstructions: row.special_instructions ?? undefined,
    notes:               row.notes              ?? undefined,
    rateConPdf:          row.rate_con_pdf       ?? undefined,
    accessorials:        (row.accessorials as Accessorial[] | null) ?? undefined,
    priority:            row.priority           ?? undefined,
    eventKind:           ((row.event_kind as EventKind) ?? "revenue") as EventKind,
    nonRevenueType:      row.non_revenue_type   ?? undefined,
    createdByName:       row.created_by_name    ?? undefined,
    createdAt:           row.created_at         ?? undefined,
    auditLog:            (row.audit_log as LoadAuditEntry[] | null) ?? undefined,
    stops:               undefined, // populated separately
  };
}

// ── App domain → DB insert ──────────────────────────────────────────────

export function appEventToDb(
  ev: Omit<Load, "id">,
  orgId: string,
  id?: string,
): LoadInsert {
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
    accessorials:         ev.accessorials        ?? null,
    priority:             ev.priority            ?? false,
    event_kind:           ev.eventKind           ?? "revenue",
    non_revenue_type:     ev.nonRevenueType      ?? null,
    created_by_name:      ev.createdByName       ?? null,
    audit_log:            ev.auditLog            ?? null,
    deleted_at:           null,
  };
}
