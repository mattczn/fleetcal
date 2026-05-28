/**
 * /v1/maintenance-action-items — ops's tracked maintenance work.
 *
 * Items land here either via /v1/maintenance-reports/:id/convert (the
 * driver-report → action-item flow) or via POST here for ad-hoc work
 * orders that didn't come from a report.
 *
 * Clerk-auth (org-scoped). No driver-side surface — drivers see
 * historical reports, not work orders.
 */
import { Hono } from "hono";
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_ACTION_STATUSES,
  type ListMaintenanceActionItemsResponse,
  type GetMaintenanceActionItemResponse,
  type CreateMaintenanceActionItemRequest,
  type CreateMaintenanceActionItemResponse,
  type UpdateMaintenanceActionItemRequest,
  type UpdateMaintenanceActionItemResponse,
  type UploadMaintenanceActionItemPhotoResponse,
  type DeleteMaintenanceActionItemPhotoResponse,
  type MaintenanceActionItemPhoto,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { getUserDisplayName } from "../lib/clerk.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import {
  rowToActionItem,
  ACTION_ITEM_COLS,
  ACTION_ITEM_COLS_LEGACY,
  isMissingColumnError,
  type MaintenanceActionItemRow,
} from "./maintenance-reports.js";

const actionItems = new Hono<{ Variables: AuthVariables }>();

actionItems.use("*", requireModule("maintenance"), requireCapability("maintenance.access"));

// ── Shared photo helpers ────────────────────────────────────────────────
//
// We reuse the same Supabase Storage bucket maintenance reports use
// (`maintenance-photos`). Storage paths for action items live under
// "<org>/action_items/<item-id>/<ts>_<rand>.<ext>" so they can't
// collide with report photos ("<org>/<report-id>/...").
//
// Signed URLs are minted with a 1-hour TTL on every list/upload —
// long enough for any reasonable dispatcher session, short enough
// that a leaked URL doesn't grant indefinite access.

const PHOTO_BUCKET = "maintenance-photos";
const PHOTO_URL_TTL_SECONDS = 60 * 60;

// ── Linked-events helper (M:N join) ─────────────────────────────────────
//
// Each work order can link to many calendar events and vice-versa via
// maintenance_action_item_events. We fetch + denormalize start dates
// here so the LIST endpoint can attach `linkedEvents: [{id,start},…]`
// onto every row in one batch, and the maintenance board can position
// the WO on each linked day without a second round-trip.
//
// Pre-migration safety: if either the join table or the join column
// is missing (deploy beat the SQL), we log once and return an empty
// map. Older single-link rows still surface via the rowToActionItem's
// legacy `eventId` hint.

interface ActionItemEventJoinRow {
  action_item_id: string;
  event_id:       string;
  events: { id: string; start: string } | null;
}

/** The join table is post-typegen — cast the client to `any` for
 *  these queries until the generated types catch up. Same pattern
 *  the rest of the codebase uses for fresh tables (closeout, fuel
 *  transactions, etc. all cast inserts/updates `as any`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabaseAny: any = supabase;

async function fetchLinkedEventsMap(
  actionItemIds: string[],
): Promise<Map<string, Array<{ id: string; start: string }>>> {
  const out = new Map<string, Array<{ id: string; start: string }>>();
  if (actionItemIds.length === 0) return out;
  const { data, error } = await supabaseAny
    .from("maintenance_action_item_events")
    .select("action_item_id, event_id, events:event_id (id, start)")
    .in("action_item_id", actionItemIds);
  if (error) {
    if (/relation .* does not exist/i.test(error.message ?? "")) {
      console.warn("[fetchLinkedEventsMap] join table missing — apply 20260601_maintenance_action_item_events migration");
      return out;
    }
    console.error("[fetchLinkedEventsMap] join query failed:", error);
    return out;
  }
  const rows = (data ?? []) as unknown as ActionItemEventJoinRow[];
  for (const r of rows) {
    if (!r.events) continue; // event deleted — skip orphan join (defensive; FK cascade should prevent)
    const arr = out.get(r.action_item_id) ?? [];
    arr.push({ id: r.events.id, start: r.events.start });
    out.set(r.action_item_id, arr);
  }
  // Sort each list oldest-first so calendar bucketing has a stable order.
  for (const arr of out.values()) arr.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

/** Replace the entire set of linked events for one work order. Used
 *  by PATCH to honor `eventIds`. Returns the new linked-events list
 *  (with start dates) for embedding into the response, OR null if the
 *  join table is missing pre-migration (caller falls back to the
 *  legacy event_id column write). */
async function replaceLinkedEvents(
  actionItemId: string,
  eventIds: string[],
): Promise<Array<{ id: string; start: string }> | null> {
  // Deduplicate defensively — repeated id in the request shouldn't
  // upset the PK.
  const wanted = Array.from(new Set(eventIds));

  // Delete-all-then-insert keeps the implementation simple and matches
  // the "replace entire set" semantics in the API contract. A diff-based
  // approach (compute add/remove) would shave a query but the join is
  // tiny per WO.
  const { error: delErr } = await supabaseAny
    .from("maintenance_action_item_events")
    .delete()
    .eq("action_item_id", actionItemId);
  if (delErr) {
    if (/relation .* does not exist/i.test(delErr.message ?? "")) {
      console.warn("[replaceLinkedEvents] join table missing — write skipped (apply 20260601 migration)");
      return null;
    }
    console.error("[replaceLinkedEvents] delete failed:", delErr);
    throw delErr;
  }

  if (wanted.length === 0) {
    console.info("[replaceLinkedEvents]", actionItemId, "cleared all links");
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertRows = wanted.map(id => ({ action_item_id: actionItemId, event_id: id })) as any[];
  const { error: insErr } = await supabaseAny
    .from("maintenance_action_item_events")
    .insert(insertRows);
  if (insErr) {
    console.error("[replaceLinkedEvents] insert failed:", insErr, "rows:", insertRows);
    throw insErr;
  }
  console.info("[replaceLinkedEvents]", actionItemId, "wrote", wanted.length, "links:", wanted);

  // Re-fetch with event start dates for the response.
  return (await fetchLinkedEventsMap([actionItemId])).get(actionItemId) ?? [];
}

interface ActionItemPhotoRow {
  id:             string;
  action_item_id: string;
  org_id:         string;
  storage_path:   string;
  file_name:      string;
  mime_type:      string | null;
  size_bytes:     number | null;
  uploaded_by:    string | null;
  uploaded_at:    string;
}

function rowToActionItemPhoto(r: ActionItemPhotoRow, signedUrl?: string): MaintenanceActionItemPhoto {
  return {
    id:           r.id,
    actionItemId: r.action_item_id,
    fileName:     r.file_name,
    mimeType:     r.mime_type   ?? undefined,
    sizeBytes:    r.size_bytes  ?? undefined,
    uploadedBy:   r.uploaded_by ?? undefined,
    uploadedAt:   r.uploaded_at,
    signedUrl,
  };
}

/** Bulk-fetch photos for a set of action_item_ids and mint signed
 *  URLs for each in one batch. Returns Map<actionItemId, photos[]>
 *  so the LIST endpoint can attach photos onto each item in O(1).
 *  Best-effort: if the table doesn't exist yet (pre-migration) the
 *  caller falls back to empty arrays so the board still loads. */
async function fetchActionItemPhotosMap(
  ids: string[],
): Promise<Map<string, MaintenanceActionItemPhoto[]>> {
  const out = new Map<string, MaintenanceActionItemPhoto[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("maintenance_action_item_photos")
    .select("id, action_item_id, org_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, uploaded_at")
    .in("action_item_id", ids)
    .order("uploaded_at", { ascending: true });
  if (error) {
    // Pre-migration deployments — table doesn't exist yet. Log once
    // and return empty; the bridge code on the work order itself
    // still works without photos.
    if (isMissingColumnError(error) || /relation .* does not exist/i.test(error.message ?? '')) {
      console.warn("[fetchActionItemPhotosMap] table missing — apply 20260530_maintenance_action_item_photos migration");
      return out;
    }
    console.error("[fetchActionItemPhotosMap] photos query failed:", error);
    return out;
  }
  const rows = (data ?? []) as ActionItemPhotoRow[];
  if (rows.length === 0) return out;
  const paths = rows.map(r => r.storage_path);
  const { data: signed } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(paths, PHOTO_URL_TTL_SECONDS);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
    urlByPath.set(s.path, s.signedUrl);
  }
  for (const r of rows) {
    const arr = out.get(r.action_item_id) ?? [];
    arr.push(rowToActionItemPhoto(r, urlByPath.get(r.storage_path)));
    out.set(r.action_item_id, arr);
  }
  return out;
}

function clampLimit(raw: string | undefined, fallback = 100): number {
  const n = Number(raw ?? String(fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 500);
}

function validateAssetOrTrailer(body: { assetId?: number; trailerId?: number }): string[] {
  const errors: string[] = [];
  const hasAsset   = body.assetId   != null && Number.isFinite(body.assetId);
  const hasTrailer = body.trailerId != null && Number.isFinite(body.trailerId);
  if (hasAsset && hasTrailer) errors.push("exactly one of assetId / trailerId");
  if (!hasAsset && !hasTrailer) errors.push("one of assetId / trailerId required");
  return errors;
}

// ── POST /v1/maintenance-action-items — create ad-hoc ──────────────────

actionItems.post("/", requireCapability("maintenance.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");

  let body: CreateMaintenanceActionItemRequest;
  try { body = await c.req.json<CreateMaintenanceActionItemRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400); }

  const errors = validateAssetOrTrailer(body);
  if (!body.title || !body.title.trim()) errors.push("title required");
  if (body.category && !(MAINTENANCE_CATEGORIES as readonly string[]).includes(body.category)) errors.push("category invalid");
  if (body.priority && !(MAINTENANCE_PRIORITIES as readonly string[]).includes(body.priority)) errors.push("priority invalid");
  if (errors.length) return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);

  // Resolve creator's display name from Clerk so the dispatcher UI's
  // Activity panel reads "Created … by Matt Curzon" instead of the
  // raw Clerk user_id (user_3Cgz7uSjL0IX…). Best-effort: if Clerk is
  // unreachable, we still insert with a null name and the UI falls
  // back to a friendlier placeholder. Same pattern as loads.
  const createdByName = await getUserDisplayName(userId);

  const insertRow: Record<string, unknown> = {
    org_id:           orgId,
    asset_id:         body.assetId   ?? null,
    trailer_id:       body.trailerId ?? null,
    title:            body.title.trim(),
    description:      body.description?.trim() || null,
    category:         body.category ?? "repair",
    priority:         body.priority ?? "normal",
    status:           "open",
    out_of_service:   !!body.outOfService,
    scheduled_date:   body.scheduledDate ?? null,
    due_date:         body.dueDate       ?? null,
    vendor:           body.vendor?.trim() || null,
    estimated_cost:   body.estimatedCost ?? null,
    // Optional pre-link to a calendar event (e.g. dispatcher creating
    // the work order from inside a maintenance block on the calendar).
    event_id:         body.eventId       ?? null,
    created_by:       userId,
    created_by_name:  createdByName,
  };

  // First attempt with the new schema. If Supabase rejects because
  // the *_by_name column doesn't exist yet, retry without those
  // fields. Same bridge as the LIST endpoint above.
  const tryInsert = async (row: Record<string, unknown>, cols: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase.from("maintenance_action_items").insert(row as any).select(cols).single();

  let { data, error } = await tryInsert(insertRow, ACTION_ITEM_COLS);
  if (error && isMissingColumnError(error)) {
    console.warn("[POST /v1/maintenance-action-items] new schema missing — retrying with legacy cols. Error:", { code: error.code, message: error.message });
    // Drop both forward-only columns (created_by_name + event_id) so
    // we can still insert against an environment that hasn't applied
    // the latest migration. event_id was added in
    // 20260527_action_item_event_link.sql — pre-migration envs reject
    // it with "column does not exist."
    const { created_by_name: _drop1, event_id: _drop2, ...legacyRow } = insertRow;
    void _drop1; void _drop2;
    ({ data, error } = await tryInsert(legacyRow, ACTION_ITEM_COLS_LEGACY));
  }
  if (error || !data) {
    // Log the full error shape so schema-cache / RLS / constraint
    // issues are obvious from the Railway logs without needing repro.
    console.error("[POST /v1/maintenance-action-items] insert failed:", {
      code:    error?.code,
      message: error?.message,
      details: (error as { details?: string } | null | undefined)?.details,
      hint:    (error as { hint?: string }    | null | undefined)?.hint,
    });
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  // Mirror the pre-link into the join table so listings by-event
  // include this freshly-created WO right away. Best-effort —
  // failures here don't roll back the row insert; the denormalized
  // event_id column already captured the relationship.
  const newRow = data as unknown as MaintenanceActionItemRow;
  let createdLinkedEvents: Array<{ id: string; start: string }> | undefined;
  if (body.eventId) {
    try {
      const written = await replaceLinkedEvents(newRow.id, [body.eventId]);
      if (written !== null) createdLinkedEvents = written;
    } catch (joinErr) {
      console.error("[POST /v1/maintenance-action-items] join mirror failed:", joinErr);
    }
  }
  const res: CreateMaintenanceActionItemResponse = {
    actionItem: rowToActionItem(newRow, createdLinkedEvents),
  };
  return c.json(res);
});

// ── GET /v1/maintenance-action-items — list ─────────────────────────────

actionItems.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const status        = url.searchParams.get("status");
  const priority      = url.searchParams.get("priority");
  const category      = url.searchParams.get("category");
  const oosRaw        = url.searchParams.get("outOfService");
  const assetIdRaw    = url.searchParams.get("assetId");
  const trailerRaw    = url.searchParams.get("trailerId");
  const scheduledFrom = url.searchParams.get("scheduledFrom");
  const scheduledTo   = url.searchParams.get("scheduledTo");
  const eventIdRaw    = url.searchParams.get("eventId");
  const limit  = clampLimit(url.searchParams.get("limit") ?? undefined);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

  // Builder factory — same filters every time, only the SELECT column
  // list differs between the new-schema and legacy attempts. Wrapping
  // in a function so we can re-issue cleanly without mutating state.
  const build = (cols: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("maintenance_action_items")
      .select(cols, { count: "exact" })
      .eq("org_id", orgId)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });
    if (status   && (MAINTENANCE_ACTION_STATUSES as readonly string[]).includes(status))   q = q.eq("status", status);
    if (priority && (MAINTENANCE_PRIORITIES      as readonly string[]).includes(priority)) q = q.eq("priority", priority);
    if (category && (MAINTENANCE_CATEGORIES      as readonly string[]).includes(category)) q = q.eq("category", category);
    if (oosRaw === "true")  q = q.eq("out_of_service", true);
    if (oosRaw === "false") q = q.eq("out_of_service", false);
    if (assetIdRaw) q = q.eq("asset_id",   Number(assetIdRaw));
    if (trailerRaw) q = q.eq("trailer_id", Number(trailerRaw));
    if (scheduledFrom) q = q.gte("scheduled_date", scheduledFrom);
    if (scheduledTo)   q = q.lt("scheduled_date",  scheduledTo);
    return q.range(offset, offset + limit - 1);
  };

  // Calendar-side query: "give me every work order linked to this
  // event." Powers the Linked Work Orders section on a non-revenue
  // maintenance block. We union TWO sources to be resilient to any
  // data inconsistency between the join table and the denormalized
  // column (e.g. an older code path wrote only to the column, or a
  // partial migration left rows in one place but not the other):
  //
  //   1. maintenance_action_item_events  (the canonical M:N join)
  //   2. maintenance_action_items.event_id (legacy 1:1 column)
  //
  // Either source matching is enough to surface the WO as "linked."
  // The PATCH handler writes to BOTH, so going forward they stay
  // in sync; this defensive read keeps stragglers from any prior
  // schema state from disappearing from the UI.
  let eventLinkedIdsUnion: Set<string> | null = null;
  if (eventIdRaw) {
    const ids = new Set<string>();

    // Source 1: the M:N join.
    const { data: joinData, error: joinErr } = await supabaseAny
      .from("maintenance_action_item_events")
      .select("action_item_id")
      .eq("event_id", eventIdRaw);
    if (joinErr && !/relation .* does not exist/i.test(joinErr.message ?? "")) {
      console.error("[GET .../action-items?eventId] join lookup failed:", joinErr);
      return c.json({ error: "fetch_failed", detail: joinErr.message } satisfies ApiErrorResponse, 500);
    }
    for (const r of (joinData ?? []) as Array<{ action_item_id: string }>) {
      ids.add(r.action_item_id);
    }

    // Source 2: the denormalized column. Catch missing-column
    // errors so an org on an older schema still gets a sensible
    // response (no rows just means nothing's linked yet).
    const { data: colData, error: colErr } = await supabase
      .from("maintenance_action_items")
      .select("id")
      .eq("org_id", orgId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq("event_id" as any, eventIdRaw);
    if (colErr && !isMissingColumnError(colErr)) {
      console.error("[GET .../action-items?eventId] column lookup failed:", colErr);
    }
    for (const r of (colData ?? []) as Array<{ id: string }>) {
      ids.add(r.id);
    }

    eventLinkedIdsUnion = ids;
    // Useful while we're debugging the multi-link rollout — strip
    // once the rollout has settled.
    console.info("[GET .../action-items?eventId] event:", eventIdRaw, "linked WOs:", Array.from(ids));
  }
  const applyEventFilter = (q: ReturnType<typeof build>) => {
    if (!eventIdRaw) return q;
    if (eventLinkedIdsUnion === null) return q;
    if (eventLinkedIdsUnion.size === 0) {
      // Empty result sentinel — postgrest .in("id", []) returns
      // every row, so use a no-match uuid instead.
      return q.eq("id", "00000000-0000-0000-0000-000000000000");
    }
    return q.in("id", Array.from(eventLinkedIdsUnion));
  };

  // First attempt: full schema. If it fails because the *_by_name
  // columns are missing (deploy happened before the migration), fall
  // back to the legacy SELECT so the dispatcher's board still loads.
  // Without this guard the UI sees an empty array on every fresh
  // deploy until the operator manually applies the migration.
  let { data, error, count } = await applyEventFilter(build(ACTION_ITEM_COLS));
  if (error && isMissingColumnError(error)) {
    console.warn("[GET /v1/maintenance-action-items] new columns missing — retrying with legacy schema. Apply the 20260530_maintenance_action_items_created_by_name migration to silence this.");
    ({ data, error, count } = await applyEventFilter(build(ACTION_ITEM_COLS_LEGACY)));
  }
  if (error) {
    console.error("[GET /v1/maintenance-action-items] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = (data ?? []) as unknown as MaintenanceActionItemRow[];
  // Embed dispatcher-uploaded photos + linked events on each item so
  // the board / modal don't have to round-trip per work order. Pre-
  // migration envs return empty maps and the board still renders.
  const ids = rows.map(r => r.id);
  const [photosByItem, linkedByItem] = await Promise.all([
    fetchActionItemPhotosMap(ids),
    fetchLinkedEventsMap(ids),
  ]);
  const res: ListMaintenanceActionItemsResponse = {
    actionItems: rows.map(r => ({
      ...rowToActionItem(r, linkedByItem.get(r.id)),
      photos: photosByItem.get(r.id) ?? [],
    })),
    total:       count ?? rows.length,
    limit,
    offset,
  };
  return c.json(res);
});

// ── GET /v1/maintenance-action-items/:id ────────────────────────────────

actionItems.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data, error } = await supabase
    .from("maintenance_action_items")
    .select(ACTION_ITEM_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const [photosByItem, linkedByItem] = await Promise.all([
    fetchActionItemPhotosMap([id]),
    fetchLinkedEventsMap([id]),
  ]);
  const res: GetMaintenanceActionItemResponse = {
    actionItem: {
      ...rowToActionItem(data as unknown as MaintenanceActionItemRow, linkedByItem.get(id)),
      photos: photosByItem.get(id) ?? [],
    },
  };
  return c.json(res);
});

// ── PATCH /v1/maintenance-action-items/:id ──────────────────────────────

actionItems.patch("/:id", requireCapability("maintenance.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");

  let body: UpdateMaintenanceActionItemRequest;
  try { body = await c.req.json<UpdateMaintenanceActionItemRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400); }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("title"       in body) update.title       = (body.title ?? "").trim() || null;
  if ("description" in body) update.description = body.description?.toString().trim() || null;
  if ("category" in body && body.category) {
    if (!(MAINTENANCE_CATEGORIES as readonly string[]).includes(body.category)) {
      return c.json({ error: "validation_failed", errors: ["category invalid"] } satisfies ApiErrorResponse, 400);
    }
    update.category = body.category;
  }
  if ("priority" in body && body.priority) {
    if (!(MAINTENANCE_PRIORITIES as readonly string[]).includes(body.priority)) {
      return c.json({ error: "validation_failed", errors: ["priority invalid"] } satisfies ApiErrorResponse, 400);
    }
    update.priority = body.priority;
  }
  if ("status" in body && body.status) {
    if (!(MAINTENANCE_ACTION_STATUSES as readonly string[]).includes(body.status)) {
      return c.json({ error: "validation_failed", errors: ["status invalid"] } satisfies ApiErrorResponse, 400);
    }
    update.status = body.status;
    // Auto-stamp completion when transitioning to 'done'. Caller can
    // override completedBy via the same payload (typed as a mechanic
    // / vendor name in the UI). When omitted, fill from the acting
    // dispatcher's Clerk identity — IMPORTANT: write the resolved
    // *display name* into completed_by, not the raw user_id, since
    // the "Completed by" field is shown verbatim in the modal text
    // input and we don't want user_3Cgz… leaking there. Falls back
    // to the user_id only if Clerk lookup fails (better than null).
    if (body.status === 'done') {
      update.completed_at = new Date().toISOString();
      if (body.completedBy === undefined) {
        const name = await getUserDisplayName(userId);
        update.completed_by      = name ?? userId;
        update.completed_by_name = name;
      } else {
        // Dispatcher typed a free-text name (vendor / shop). Mirror
        // it into both columns so the display path is uniform.
        update.completed_by_name = body.completedBy?.trim() || null;
      }
    }
  }
  if ("outOfService" in body && typeof body.outOfService === 'boolean') {
    update.out_of_service = body.outOfService;
  }
  if ("scheduledDate" in body) update.scheduled_date = body.scheduledDate ?? null;
  if ("dueDate"       in body) update.due_date       = body.dueDate       ?? null;
  if ("vendor"        in body) update.vendor         = body.vendor ?? null;
  if ("estimatedCost" in body) update.estimated_cost = body.estimatedCost ?? null;
  if ("actualCost"    in body) update.actual_cost    = body.actualCost    ?? null;
  // Link / unlink calendar events. Two-tier field:
  //   • `eventIds: string[]` (preferred, multi-link) → REPLACES the
  //     join set. We compute the desired set here and call
  //     replaceLinkedEvents(...) AFTER the row update lands.
  //   • `eventId: string|null` (legacy 1:1)
  //         null   → clear all links.
  //         string → replace set with just this id.
  // `event_id` column on the row is also updated as the
  // denormalized "primary" pointer (set to the first id in the
  // desired set, or null when empty). `eventIds` takes precedence
  // when both are present.
  let desiredEventIds: string[] | undefined; // undefined = leave unchanged
  if ("eventIds" in body && Array.isArray(body.eventIds)) {
    desiredEventIds = Array.from(new Set(body.eventIds.filter(x => typeof x === 'string' && x.length > 0)));
  } else if ("eventId" in body) {
    desiredEventIds = body.eventId ? [body.eventId] : [];
  }
  if (desiredEventIds !== undefined) {
    update.event_id = desiredEventIds[0] ?? null;
    // Diagnostic — strip once the multi-link rollout has settled.
    console.info("[PATCH .../action-items]", id, "desiredEventIds:", desiredEventIds, "→ column event_id:", update.event_id);
  }
  if ("completedBy"   in body) {
    update.completed_by      = body.completedBy ?? null;
    // Mirror the free-text name into completed_by_name so the
    // display path doesn't have to guess which column to read from.
    update.completed_by_name = body.completedBy?.trim() || null;
  }

  if (Object.keys(update).length <= 1) { // only updated_at
    return c.json({ error: "validation_failed", errors: ["no fields to update"] } satisfies ApiErrorResponse, 400);
  }

  // Same retry-with-legacy-schema bridge as POST + LIST.
  const tryUpdate = async (patch: Record<string, unknown>, cols: string) =>
    supabase
      .from("maintenance_action_items")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(patch as any)
      .eq("id", id)
      .eq("org_id", orgId)
      .select(cols)
      .maybeSingle();

  let { data, error } = await tryUpdate(update, ACTION_ITEM_COLS);
  if (error && isMissingColumnError(error)) {
    console.warn("[PATCH /v1/maintenance-action-items] new schema missing — retrying with legacy cols. Error:", { code: error.code, message: error.message });
    // Drop every forward-only column from the update payload — the
    // schema-cache error can be triggered by ANY of them. Same set as
    // the POST handler. event_id was added in
    // 20260527_action_item_event_link.sql.
    const { completed_by_name: _cn, created_by_name: _cbn, event_id: _ev, ...legacyUpdate } = update;
    void _cn; void _cbn; void _ev;
    ({ data, error } = await tryUpdate(legacyUpdate, ACTION_ITEM_COLS_LEGACY));
  }
  if (error) {
    console.error("[PATCH /v1/maintenance-action-items/:id] update failed:", {
      code:    error.code,
      message: error.message,
      details: (error as { details?: string } | null | undefined)?.details,
      hint:    (error as { hint?: string }    | null | undefined)?.hint,
    });
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  // Apply the multi-link join AFTER the row update — that way we
  // don't orphan join rows on a failed row update, and the response
  // reflects the freshly-written state. Best-effort: a join failure
  // is logged but doesn't fail the whole PATCH (the denormalized
  // event_id column already captured the primary link). Skips
  // gracefully when the join table is missing pre-migration.
  let freshLinkedEvents: Array<{ id: string; start: string }> | undefined;
  if (desiredEventIds !== undefined) {
    try {
      const written = await replaceLinkedEvents(id, desiredEventIds);
      if (written !== null) freshLinkedEvents = written;
    } catch (joinErr) {
      console.error("[PATCH /v1/maintenance-action-items/:id] join write failed:", joinErr);
    }
  } else {
    // No link change — still want to surface the current join state
    // in the response so consumers stay in sync.
    freshLinkedEvents = (await fetchLinkedEventsMap([id])).get(id);
  }

  // Auto-fill scheduledDate from the earliest linked event when:
  //   1. Links are being added (desiredEventIds non-empty), AND
  //   2. The caller didn't explicitly set scheduledDate in this
  //      PATCH (so we don't override an explicit value), AND
  //   3. The row's scheduled_date column is currently null (so we
  //      don't override an existing user choice).
  // Mirrors the product rule: "scheduling a WO on the calendar
  // should reflect in the modal's Scheduled for picker." Done as a
  // second UPDATE (small, fire-and-forget) — keeps the first
  // update minimal so the schema-bridge / retry logic stays simple.
  let postScheduledRow: MaintenanceActionItemRow | null = null;
  if (
    !("scheduledDate" in body)
    && freshLinkedEvents
    && freshLinkedEvents.length > 0
    && (data as unknown as MaintenanceActionItemRow).scheduled_date == null
  ) {
    // freshLinkedEvents is sorted oldest-first by fetchLinkedEventsMap;
    // strip the time portion so we store YYYY-MM-DD (the column is
    // DATE, not timestamp).
    const earliestIso = freshLinkedEvents[0].start;
    const earliestDate = earliestIso.slice(0, 10);
    const { data: schedData, error: schedErr } = await supabase
      .from("maintenance_action_items")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ scheduled_date: earliestDate, updated_at: new Date().toISOString() } as any)
      .eq("id", id)
      .eq("org_id", orgId)
      .select(ACTION_ITEM_COLS)
      .maybeSingle();
    if (schedErr) {
      console.warn("[PATCH .../action-items] scheduledDate auto-fill failed (non-fatal):", schedErr);
    } else if (schedData) {
      postScheduledRow = schedData as unknown as MaintenanceActionItemRow;
      console.info("[PATCH .../action-items]", id, "auto-filled scheduled_date:", earliestDate);
    }
  }

  const res: UpdateMaintenanceActionItemResponse = {
    actionItem: rowToActionItem(
      postScheduledRow ?? (data as unknown as MaintenanceActionItemRow),
      freshLinkedEvents,
    ),
  };
  return c.json(res);
});

// ── POST /v1/maintenance-action-items/:id/photos ────────────────────────
//
// Multipart upload — one file per request (the client loops over
// selected files). Mirrors the driver-side maintenance-reports
// photo upload pattern so storage paths and the bucket are shared.
// Storage path scheme: "<org>/action_items/<item-id>/<ts>_<rand>.<ext>"
// — distinct from report uploads ("<org>/<report-id>/...") so the
// two can coexist in the same bucket without collision.

actionItems.post("/:id/photos", requireCapability("maintenance.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");

  // Confirm the action item exists in this org. Don't require
  // capability beyond maintenance.edit (the parent route's gate) —
  // any dispatcher who can edit work orders can attach evidence.
  const { data: ai, error: aiErr } = await supabase
    .from("maintenance_action_items")
    .select("id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (aiErr) return c.json({ error: "fetch_failed", detail: aiErr.message } satisfies ApiErrorResponse, 500);
  if (!ai)   return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  let body: { file?: File };
  try { body = await c.req.parseBody() as { file?: File }; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] } satisfies ApiErrorResponse, 400); }
  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] } satisfies ApiErrorResponse, 400);
  }

  // Build a collision-resistant path. Timestamp + random hex inside
  // the per-item folder so even a rapid burst of uploads can't
  // overwrite each other.
  const ext  = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/action_items/${id}/${Date.now()}_${rand}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST .../photos] storage upload failed:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message } satisfies ApiErrorResponse, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: photoRow, error: insertErr } = await supabase
    .from("maintenance_action_item_photos")
    .insert({
      action_item_id: id,
      org_id:         orgId,
      storage_path:   storagePath,
      file_name:      file.name,
      mime_type:      file.type || null,
      size_bytes:     bytes.length,
      uploaded_by:    userId,
    } as any)
    .select("id, action_item_id, org_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, uploaded_at")
    .single();
  if (insertErr || !photoRow) {
    // Roll back the storage upload if the DB row didn't take —
    // otherwise we end up with an orphan in the bucket.
    void supabase.storage.from(PHOTO_BUCKET).remove([storagePath]);
    console.error("[POST .../photos] insert failed:", insertErr);
    return c.json({ error: "insert_failed", detail: insertErr?.message } satisfies ApiErrorResponse, 500);
  }

  // Sign one URL for the response so the client can render the
  // freshly-uploaded photo without an extra round trip.
  const { data: signed } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(storagePath, PHOTO_URL_TTL_SECONDS);

  const res: UploadMaintenanceActionItemPhotoResponse = {
    photo: rowToActionItemPhoto(
      photoRow as unknown as ActionItemPhotoRow,
      signed?.signedUrl,
    ),
  };
  return c.json(res);
});

// ── DELETE /v1/maintenance-action-items/photos/:id ──────────────────────
//
// Static "/photos/..." segment must be registered BEFORE the
// "/:id" delete below so Hono's radix matches it first. (Hono does
// prefer static over param, but explicit ordering is safer.)

actionItems.delete("/photos/:id", requireCapability("maintenance.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data: row, error: lookupErr } = await supabase
    .from("maintenance_action_item_photos")
    .select("id, org_id, storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (lookupErr) return c.json({ error: "fetch_failed", detail: lookupErr.message } satisfies ApiErrorResponse, 500);
  if (!row)      return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const storagePath = (row as { storage_path: string }).storage_path;

  const { error: delErr } = await supabase
    .from("maintenance_action_item_photos")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (delErr) {
    console.error("[DELETE .../photos/:id] DB delete failed:", delErr);
    return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
  }

  // Best-effort bucket cleanup; not fatal if it fails (the DB row
  // is gone, the orphan can be swept later).
  void supabase.storage.from(PHOTO_BUCKET).remove([storagePath]);

  const res: DeleteMaintenanceActionItemPhotoResponse = { ok: true };
  return c.json(res);
});

// ── DELETE /v1/maintenance-action-items/:id ─────────────────────────────

actionItems.delete("/:id", requireCapability("maintenance.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { error } = await supabase
    .from("maintenance_action_items")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/maintenance-action-items/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

export default actionItems;
