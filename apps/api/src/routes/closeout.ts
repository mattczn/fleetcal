/**
 * /v1/closeout — POD verification + release workflow.
 *
 * The closeout queue is the dispatcher's daily list of loads waiting on
 * paperwork verification before they can be invoiced. Date-driven, not
 * status-driven — drivers don't always mark loads delivered, but a load
 * whose end date has arrived still needs to be worked. (Accounting-side
 * invoicing tools live separately under /payroll-style modules.)
 *
 *   GET    /v1/closeout/queue?tab=pending|flagged|verified|invoiced
 *   PATCH  /v1/closeout/loads/:id  — verify, flag, set invoice_doc_ids, …
 */

import { Hono } from "hono";
import {
  type ApiErrorResponse,
  type Load,
} from "@fleetcal/types";
import { joinEventLoadToApp } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { fetchStopsByEvent } from "../lib/stops.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

const closeout = new Hono<{ Variables: AuthVariables }>();

// Every closeout endpoint requires closeout.access. Mutations
// (release / flag actions on PATCH /loads/:id) check the more
// specific cap inline based on `action`. Maintenance role is locked
// out entirely.
// Module gate runs first — if an org's plan doesn't include Closeout,
// the response is "module_disabled" rather than the misleading
// "missing_capability". Then the per-role check.
closeout.use("*", requireModule("closeout"), requireCapability("closeout.access"));

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at," +
  "confirmed_at,confirmed_by,confirm_reminder_sent_at";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,commodity,weight," +
  "dispatcher,notes,internal_notes," +
  "accessorials,rate_con_pdf,ref_nums," +
  "billing_status,flagged_reason,flagged_note,flagged_at,flagged_by,follow_ups,is_tonu," +
  "verified_at,verified_by,invoice_doc_ids,document_counts," +
  "audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

// Grace window before missing-POD fires. Driver / office gets a full
// day to upload paperwork after delivery before we surface it as an
// impediment. Anything less generates noise during the normal flow.
const POD_GRACE_MS = 24 * 60 * 60 * 1000;

// ─── Auto-flag derivation ───────────────────────────────────────────────
//
// A load belongs in the Flagged bucket when it has any "impediment" —
// something blocking it from being closed out and released for billing.
// The reasons live on different pieces of data:
//
//   • Manual flag      → load.billing_status === 'on_hold'
//   • Pending accessorial → any accessorial with status not in
//                            {approved, denied}
//   • Missing POD       → no load_documents row with kind='pod' for the
//                          load, AND the load is past its delivery end
//
// The closeout queue computes this server-side so the Flagged tab
// count is correct without the client having to re-derive.

interface AccessorialRow {
  id?: string;
  status?: 'requested' | 'approved' | 'denied' | string;
  category?: string;
  amount?: number;
}

function hasPendingAccessorial(load: { accessorials?: unknown }): boolean {
  const arr = load.accessorials;
  if (!Array.isArray(arr)) return false;
  return (arr as AccessorialRow[]).some(a => a.status !== 'approved' && a.status !== 'denied');
}

function isPodMissing(loadId: string | undefined | null, podCountByLoad: Map<string, number>): boolean {
  if (!loadId) return false;
  return (podCountByLoad.get(loadId) ?? 0) === 0;
}

/** Has the delivery end passed by at least the grace window? Returns
 *  false if `deliveryEnd` is null/invalid — can't expect POD without
 *  a delivery date. */
function podDueByNow(deliveryEnd: string | null | undefined, nowMs: number): boolean {
  if (!deliveryEnd) return false;
  const t = new Date(deliveryEnd).getTime();
  if (isNaN(t)) return false;
  return t <= nowMs - POD_GRACE_MS;
}

/** True if a load has ANY closeout impediment. Used to split the
 *  pending vs flagged buckets without storing the state on the row.
 *
 *  `deliveryEnd` should be the DELIVERY-leg's end for relays (not
 *  the pickup leg's), and the load's own end for single-event loads.
 *  Caller builds this lookup once across all candidate rows. */
function loadIsFlagged(
  load:           { billing_status?: string; accessorials?: unknown; is_tonu?: boolean },
  loadId:         string | undefined | null,
  podCountByLoad: Map<string, number>,
  deliveryEnd:    string | null | undefined,
  nowMs:          number,
): boolean {
  if (load.billing_status === 'on_hold') return true;
  if (hasPendingAccessorial(load))       return true;
  // POD check skipped entirely for TONU — no delivery happened, no
  // paperwork expected.
  if (load.is_tonu) return false;
  if (podDueByNow(deliveryEnd, nowMs) && isPodMissing(loadId, podCountByLoad)) return true;
  return false;
}

/** Build a loadId → deliveryEnd map from candidate rows. The
 *  closeout queue returns each leg of a relay as a separate row,
 *  so we resolve to the delivery leg explicitly. Non-relay loads
 *  just map to their own end. */
function buildDeliveryEndMap(rows: Array<{ end?: string | null; load?: { id?: string | null } | null; relay_role?: string | null }>): Map<string, string> {
  const m = new Map<string, string>();
  // First pass — any end as a fallback (for orphan pickup legs whose
  // delivery counterpart isn't in our candidate set).
  for (const r of rows) {
    const id = r.load?.id;
    if (!id) continue;
    if (!m.has(id) && r.end) m.set(id, r.end);
  }
  // Second pass — delivery leg overrides.
  for (const r of rows) {
    if (r.relay_role !== 'delivery') continue;
    const id = r.load?.id;
    if (!id || !r.end) continue;
    m.set(id, r.end);
  }
  return m;
}

type Tab = "pending" | "flagged" | "verified" | "invoiced" | "paid" | "all";

closeout.get("/queue", async (c) => {
  const orgId = c.get("orgId");
  const tab = ((c.req.query("tab") ?? "pending") as Tab);
  const limit  = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  // Search query — empty / <2 chars disables search. When active, we
  // also lift the date filter on the pending tab so the search reaches
  // upcoming loads, not just the overdue working set.
  const qRaw = (c.req.query("q") ?? "").trim();
  const searching = qRaw.length >= 2;

  // Fetch revenue events whose load matches the requested billing-status
  // filter. We pull events (not loads) so each leg is a row — the client
  // can dedup by load_id when needed.
  const nowIso = new Date().toISOString();

  // Helper: build a fresh events query with the org/kind/deleted/status
  // + tab-based billing_status filters applied. Returns the builder so
  // callers can chain `.or()` / `.in()` / `.order()` / `.range()` on top.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildBaseQuery = (withCount: boolean): any => {
    const cols = `${EVENT_COLS}, load:loads!inner(${LOAD_COLS})`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("events")
      .select(cols, withCount ? { count: "exact" } : undefined)
      .eq("org_id", orgId)
      .eq("event_kind", "revenue")
      .is("deleted_at", null)
      .neq("status", "cancelled");
    // Pending + Flagged are derived: we fetch every candidate that
    // COULD be in either bucket, compute impediments below, then
    // split. Candidates = loads with billing_status in
    // {pending, on_hold}. The non-search path also applies the
    // delivered-by-now date filter so we don't surface upcoming
    // loads in the working set.
    if (tab === "pending" || tab === "flagged" || tab === "all") {
      if (!searching && tab === "pending") q = q.lte("end", nowIso);
      q = q.in("load.billing_status", ["pending", "on_hold"]);
    } else if (tab === "verified") q = q.eq("load.billing_status", "verified");
    else if   (tab === "invoiced") q = q.eq("load.billing_status", "invoiced");
    else if   (tab === "paid")     q = q.eq("load.billing_status", "paid");
    return q;
  };

  // ── Non-search path ──────────────────────────────────────────────
  // For pending/flagged: pull a wide candidate set and filter in JS
  // (we need to evaluate impediments against accessorials + POD
  // presence, which doesn't compose cleanly with PostgREST filters).
  // For other tabs: DB-paginated as before.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawRows: any[] = [];
  let totalCount = 0;
  // Total $ across the FULL filtered set (not just the page on screen),
  // deduped by loadId so a relay load counts once. Used by the bucket
  // tiles in /closeout to surface "Pending $X / Flagged $Y" the same
  // way /accounting does. We compute this in the wide-candidate and
  // search paths where we already have every matching row in hand;
  // the DB-paginated path (verified/invoiced/paid) leaves it at 0
  // since computing it there would require a separate aggregate.
  let totalLoadValue = 0;
  // Reduce a set of event rows to (uniqueLoadCount, sumLoadValue) by
  // deduping on loadId. Relays surface as two events sharing one
  // load_id; without dedup the count is inflated and the $ would be
  // double-counted (we sum the load row's load_price, which is the
  // same across legs).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aggregateByLoad = (rows: any[]): { count: number; value: number } => {
    const byLoadId = new Map<string, number>();
    let standaloneEvents = 0; // events without a load (defensive — shouldn't happen for revenue events but we count them)
    for (const r of rows) {
      const lid = r.load?.id as string | undefined;
      const price = Number(r.load?.load_price ?? 0) || 0;
      if (!lid) { standaloneEvents++; continue; }
      if (!byLoadId.has(lid)) byLoadId.set(lid, price);
    }
    let value = 0;
    for (const v of byLoadId.values()) value += v;
    return { count: byLoadId.size + standaloneEvents, value };
  };
  // Reuse-flag — when the wide-candidate path runs, we've already
  // built loadIds + we'll need POD counts; track them here so the
  // returned docCounts payload further down doesn't re-fetch.
  const wideCandidatePath = !searching && (tab === "pending" || tab === "flagged" || tab === "all");

  if (!searching && !wideCandidatePath) {
    const { data, error, count } = await buildBaseQuery(true)
      .order("priority", { ascending: false })
      .order("end",      { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) {
      console.error("[GET /v1/closeout/queue] failed:", error);
      return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
    rawRows    = (data ?? []) as unknown[] as typeof rawRows;
    totalCount = count ?? rawRows.length;
  } else if (wideCandidatePath) {
    // Fetch up to 2000 candidate events that COULD belong to
    // pending/flagged/all (billing_status IN ['pending', 'on_hold']).
    // We filter to one bucket below and dedupe to a load count.
    // 2000 events ≈ 1000-2000 unique loads (relays inflate). A busy
    // org with more than that backlog should already be investigating
    // — the cap exists so a single query can't OOM the API. Log a
    // warning so the operator sees it before users do.
    const CANDIDATE_CAP = 2000;
    const { data, error } = await buildBaseQuery(false)
      .order("priority", { ascending: false })
      .order("end",      { ascending: true })
      .range(0, CANDIDATE_CAP - 1);
    if (error) {
      console.error("[GET /v1/closeout/queue] failed:", error);
      return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candidates = (data ?? []) as any[];
    if (candidates.length >= CANDIDATE_CAP) {
      console.warn(`[GET /v1/closeout/queue] candidate cap hit (${CANDIDATE_CAP}) for org=${orgId} tab=${tab} — bucket totals may undercount`);
    }

    // Pull POD presence for these candidates — needed for the
    // missing-POD impediment check.
    const candidateLoadIds = Array.from(new Set(
      candidates.map(r => r.load?.id as string | undefined).filter((id): id is string => !!id),
    ));
    const podCount = new Map<string, number>();
    if (candidateLoadIds.length > 0) {
      const { data: pods } = await supabase
        .from("load_documents")
        .select("load_id")
        .eq("org_id", orgId)
        .eq("kind", "pod")
        .in("load_id", candidateLoadIds);
      for (const p of (pods ?? []) as Array<{ load_id: string | null }>) {
        if (p.load_id) podCount.set(p.load_id, (podCount.get(p.load_id) ?? 0) + 1);
      }
    }

    // Build delivery-end-per-load now that we have the full candidate
    // set — needed for relay loads where the pickup leg's end isn't
    // the right reference for the POD-due check.
    const deliveryEndByLoadId = buildDeliveryEndMap(candidates);
    const nowMs = Date.now();

    // Apply the impediment filter. Pending = NOT flagged.
    // `all` short-circuits the split — every candidate in the
    // pending/on_hold candidate set is returned.
    const filtered = tab === "all" ? candidates : candidates.filter(r => {
      const loadRow = r.load as { billing_status?: string; accessorials?: unknown; is_tonu?: boolean; id?: string };
      const loadId = loadRow?.id;
      const deliveryEnd = (loadId && deliveryEndByLoadId.get(loadId)) ?? r.end;
      const flagged = loadIsFlagged(loadRow, loadId, podCount, deliveryEnd, nowMs);
      return tab === "flagged" ? flagged : !flagged;
    });

    // Count UNIQUE loads (deduped by load_id). Relays are two events
    // for one load — the bucket tile should reflect "one load" so the
    // count matches what the user sees in the table (also deduped).
    const agg = aggregateByLoad(filtered);
    totalCount = agg.count;
    totalLoadValue = agg.value;
    rawRows = filtered.slice(offset, offset + limit);
  } else {
    // ── Search path: two parallel queries, merged + paginated in JS.
    // Mirrors the pattern used by /v1/loads/search since PostgREST's
    // .or() can't reliably span a foreign relation in one call.
    //
    // Query A — events whose event-level fields match.
    // Query B — events whose load-level fields match (via a load_ids
    //           lookup first, then in() on the events query).
    // Each query independently applies the tab filter so an event
    // only shows up if it belongs to the requested tab.
    const escaped = qRaw.replace(/[%,()]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const parsedNum = /^\d+$/.test(qRaw) ? Number(qRaw) : NaN;
    const numericId = Number.isFinite(parsedNum) && parsedNum <= 2147483647 ? parsedNum : null;

    const eventOr = `title.ilike.${pattern},driver_name.ilike.${pattern},notes.ilike.${pattern}`;
    const loadOr  = numericId !== null
      ? `internal_load_id.eq.${numericId},load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`
      : `load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`;

    // 1) Resolve matching load_ids first so query B can use .in().
    const { data: loadIdRows, error: loadIdErr } = await supabase
      .from("loads")
      .select("id")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .or(loadOr)
      .limit(500);
    if (loadIdErr) {
      console.error("[GET /v1/closeout/queue] load-side search failed:", loadIdErr);
      return c.json({ error: "search_failed", detail: loadIdErr.message } satisfies ApiErrorResponse, 500);
    }
    const matchedLoadIds = ((loadIdRows ?? []) as Array<{ id: string }>).map(r => r.id);

    // 2) Run event-side + load-side event queries in parallel.
    const eventSideP = buildBaseQuery(false).or(eventOr).limit(500);
    const loadSideP = matchedLoadIds.length > 0
      ? buildBaseQuery(false).in("load_id", matchedLoadIds).limit(500)
      : Promise.resolve({ data: [], error: null as unknown as null });

    const [evRes, loadRes] = await Promise.all([eventSideP, loadSideP]);
    if (evRes.error) {
      console.error("[GET /v1/closeout/queue] event-side search failed:", evRes.error);
      return c.json({ error: "search_failed", detail: evRes.error.message } satisfies ApiErrorResponse, 500);
    }
    if (loadRes.error) {
      console.error("[GET /v1/closeout/queue] load-side event fetch failed:", loadRes.error);
      return c.json({ error: "search_failed", detail: loadRes.error.message } satisfies ApiErrorResponse, 500);
    }

    // 3) Union by event id, sort by priority desc then end asc, paginate.
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged: any[] = [];
    for (const r of [...(evRes.data ?? []), ...(loadRes.data ?? [])]) {
      const row = r as { id: string };
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(r);
    }
    merged.sort((a, b) => {
      const ap = (a.priority ? 1 : 0), bp = (b.priority ? 1 : 0);
      if (ap !== bp) return bp - ap; // priority desc
      const ae = String(a.end ?? ''), be = String(b.end ?? '');
      return ae < be ? -1 : ae > be ? 1 : 0; // end asc
    });
    // Search-path impediment filter for pending/flagged tabs. Same
    // logic as the non-search wide-candidate path — we just feed it
    // the already-merged result set instead of a fresh fetch.
    let finalRows = merged;
    if (tab === "pending" || tab === "flagged" || tab === "all") {
      const candidateLoadIds = Array.from(new Set(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        merged.map((r: any) => r.load?.id as string | undefined).filter((id): id is string => !!id),
      ));
      const podCount = new Map<string, number>();
      if (candidateLoadIds.length > 0) {
        const { data: pods } = await supabase
          .from("load_documents")
          .select("load_id")
          .eq("org_id", orgId)
          .eq("kind", "pod")
          .in("load_id", candidateLoadIds);
        for (const p of (pods ?? []) as Array<{ load_id: string | null }>) {
          if (p.load_id) podCount.set(p.load_id, (podCount.get(p.load_id) ?? 0) + 1);
        }
      }
      const deliveryEndByLoadId = buildDeliveryEndMap(merged);
      const nowMs = Date.now();
      finalRows = tab === "all" ? merged : merged.filter(r => {
        const loadRow = r.load as { billing_status?: string; accessorials?: unknown; is_tonu?: boolean; id?: string };
        const loadId = loadRow?.id;
        const deliveryEnd = (loadId && deliveryEndByLoadId.get(loadId)) ?? r.end;
        const flagged = loadIsFlagged(loadRow, loadId, podCount, deliveryEnd, nowMs);
        return tab === "flagged" ? flagged : !flagged;
      });
    }
    // Same dedup as the wide-candidate path so the count matches
    // what's in the deduped table render.
    const agg = aggregateByLoad(finalRows);
    totalCount = agg.count;
    totalLoadValue = agg.value;
    rawRows = finalRows.slice(offset, offset + limit);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loads: Load[] = rawRows.map((row: any) => joinEventLoadToApp(row, row.load));

  // Attach stops so the EventModal renders fully when opened from the
  // closeout table. Without this the loads in the calendar store have
  // empty stops arrays and the modal looks blank.
  const eventIds = loads.map(l => l.id);
  const stopsByEvent = await fetchStopsByEvent(eventIds);
  for (const l of loads) {
    l.stops = stopsByEvent.get(l.id) ?? [];
  }

  // Roll up doc-kind counts per load so the queue table can render
  // RC/POD/BOL/Lumper/Scale chips in one render pass without N
  // per-load fetches.
  const loadIds = Array.from(new Set(loads.map(l => l.loadId).filter((id): id is string => !!id)));
  const docCounts: Record<string, Record<string, number>> = {};
  if (loadIds.length > 0) {
    const { data: docs } = await supabase
      .from("load_documents")
      .select("load_id, kind")
      .eq("org_id", orgId)
      .in("load_id", loadIds);
    for (const d of (docs ?? []) as Array<{ load_id: string | null; kind: string }>) {
      if (!d.load_id) continue;
      const lc = (docCounts[d.load_id] ??= {});
      lc[d.kind] = (lc[d.kind] ?? 0) + 1;
    }
  }

  return c.json({
    loads,
    docCounts,
    total: totalCount,
    totalLoadValue,
    limit,
    offset,
  });
});

interface UpdateBillingBody {
  /** Which action to take. */
  action:
    | "verify"
    | "flag"
    | "clear_flag"
    | "set_invoice_docs"
    | "mark_invoiced"
    | "mark_paid"
    | "reopen"
    | "set_priority"
    | "clear_priority"
    | "append_note"
    | "add_follow_up";
  /** Display name to record on verified_by / flagged_by / note author. */
  actorName?: string;
  /** Required for action='flag'. */
  flagReason?:
    | "missing_pod"
    | "awaiting_rate_con"
    | "detention_pending"
    | "lumper_pending"
    | "rate_mismatch"
    | "other";
  flagNote?: string;
  /** Required for action='set_invoice_docs'. */
  invoiceDocIds?: string[];
  /** Required for action='append_note'. The text body of the new note. */
  noteText?: string;
  /** Required for action='add_follow_up'. The free-form note text. */
  followUpNote?: string;
  /** Optional category tag for the follow-up timeline (pod / rate_con /
   *  rate_dispute / accessorial / other). */
  followUpCategory?: 'pod' | 'rate_con' | 'rate_dispute' | 'accessorial' | 'other';
  /** Optional resolution applied atomically with the follow-up entry. */
  followUpResolution?: {
    type:           'accessorial_status' | 'flag_cleared' | 'mark_tonu';
    /** Required when type='accessorial_status'. */
    accessorialId?: string;
    /** Required when type='accessorial_status'. */
    newStatus?:     'approved' | 'denied';
    /** Required when type='mark_tonu'. true = mark TONU, false = un-mark. */
    isTonu?:        boolean;
  };
}

interface FollowUpRow {
  id:        string;
  at:        string;
  by:        string | null;
  note:      string;
  category?: string;
  resolution?: {
    type:           string;
    accessorialId?: string;
    newStatus?:     string;
  };
}

interface InternalNoteRow {
  id:     string;
  text:   string;
  author: string | null;
  at:     string;
}

closeout.patch("/loads/:id", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<UpdateBillingBody>();

  // append_note — fetch current notes, append a new structured entry,
  // write the updated array back. Done server-side so multi-tab usage
  // can't accidentally clobber prior notes the way a client-side
  // read-modify-write would.
  if (body.action === "append_note") {
    if (!body.noteText || !body.noteText.trim()) {
      return c.json({ error: "validation_failed", errors: ["noteText required"] } satisfies ApiErrorResponse, 400);
    }
    const { data: existing, error: fetchErr } = await supabase
      .from("loads")
      .select("internal_notes")
      .eq("id", loadId)
      .eq("org_id", orgId)
      .single();
    if (fetchErr) {
      console.error("[PATCH /v1/closeout/loads/:id append_note] fetch failed:", fetchErr);
      return c.json({ error: "update_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
    }
    const prior: InternalNoteRow[] = Array.isArray(existing?.internal_notes)
      ? (existing!.internal_notes as unknown as InternalNoteRow[])
      : [];
    const newNote: InternalNoteRow = {
      // crypto.randomUUID is available in modern node/edge runtimes Hono ships on
      id:     globalThis.crypto.randomUUID(),
      text:   body.noteText.trim(),
      author: body.actorName ?? null,
      at:     new Date().toISOString(),
    };
    const next = [...prior, newNote];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase
      .from("loads")
      .update({ internal_notes: next } as any)
      .eq("id", loadId)
      .eq("org_id", orgId);
    if (error) {
      console.error("[PATCH /v1/closeout/loads/:id append_note] write failed:", error);
      return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
    return c.json({ ok: true, note: newNote });
  }

  // add_follow_up — append a single LoadFollowUp entry to
  // loads.follow_ups, optionally applying a resolution (flip an
  // accessorial's status, or clear the manual flag) in the same
  // server-side read-modify-write so multi-tab edits can't lose
  // data.
  if (body.action === "add_follow_up") {
    if (!body.followUpNote || !body.followUpNote.trim()) {
      return c.json({ error: "validation_failed", errors: ["followUpNote required"] } satisfies ApiErrorResponse, 400);
    }
    const { data: existing, error: fetchErr } = await supabase
      .from("loads")
      .select("follow_ups,accessorials,billing_status,flagged_reason,flagged_note,flagged_at,flagged_by,is_tonu")
      .eq("id", loadId)
      .eq("org_id", orgId)
      .single();
    if (fetchErr) {
      console.error("[PATCH /v1/closeout/loads/:id add_follow_up] fetch failed:", fetchErr);
      return c.json({ error: "update_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
    }

    const priorFollowUps: FollowUpRow[] = Array.isArray(existing?.follow_ups)
      ? (existing!.follow_ups as unknown as FollowUpRow[])
      : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accessorialsArr: any[] = Array.isArray(existing?.accessorials) ? (existing!.accessorials as any[]) : [];

    const newEntry: FollowUpRow = {
      id:       globalThis.crypto.randomUUID(),
      at:       new Date().toISOString(),
      by:       body.actorName ?? null,
      note:     body.followUpNote.trim(),
      category: body.followUpCategory,
    };

    // Apply the optional resolution. We mutate `accessorialsArr`
    // and/or the flag fields in-place, then write everything back
    // in a single update.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeBack: Record<string, unknown> = {
      follow_ups: [...priorFollowUps, newEntry],
    };

    if (body.followUpResolution) {
      const r = body.followUpResolution;
      if (r.type === "accessorial_status") {
        if (!r.accessorialId || !r.newStatus) {
          return c.json(
            { error: "validation_failed", errors: ["resolution accessorialId + newStatus required"] } satisfies ApiErrorResponse,
            400,
          );
        }
        const target = accessorialsArr.find(a => a?.id === r.accessorialId);
        if (!target) {
          return c.json({ error: "not_found", detail: "accessorial not found on this load" } satisfies ApiErrorResponse, 404);
        }
        target.status = r.newStatus;
        newEntry.resolution = {
          type:           "accessorial_status",
          accessorialId:  r.accessorialId,
          newStatus:      r.newStatus,
        };
        writeBack.accessorials = accessorialsArr;
        writeBack.follow_ups   = [...priorFollowUps, newEntry];
      } else if (r.type === "flag_cleared") {
        // Clear the manual flag — the auto-flag still applies if
        // an impediment remains, so the load may stay in the
        // Flagged bucket. The user's explicit flag is what we're
        // unsetting here.
        writeBack.flagged_reason = null;
        writeBack.flagged_note   = null;
        writeBack.flagged_at     = null;
        writeBack.flagged_by     = null;
        if (existing?.billing_status === "on_hold") {
          // Drop billing_status back to 'pending' so the auto-flag
          // logic re-evaluates from scratch.
          writeBack.billing_status = "pending";
        }
        newEntry.resolution = { type: "flag_cleared" };
        writeBack.follow_ups = [...priorFollowUps, newEntry];
      } else if (r.type === "mark_tonu") {
        // TONU toggle — exempts the load from the missing-POD check.
        // The user can also un-mark (isTonu=false) if it was set in
        // error. Logged with a resolution chip in the timeline.
        if (typeof r.isTonu !== "boolean") {
          return c.json(
            { error: "validation_failed", errors: ["resolution isTonu (boolean) required"] } satisfies ApiErrorResponse,
            400,
          );
        }
        writeBack.is_tonu = r.isTonu;
        newEntry.resolution = { type: "mark_tonu" };
        writeBack.follow_ups = [...priorFollowUps, newEntry];
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updErr } = await supabase
      .from("loads")
      .update(writeBack as any)
      .eq("id", loadId)
      .eq("org_id", orgId);
    if (updErr) {
      console.error("[PATCH /v1/closeout/loads/:id add_follow_up] write failed:", updErr);
      return c.json({ error: "update_failed", detail: updErr.message } satisfies ApiErrorResponse, 500);
    }
    return c.json({ ok: true, followUp: newEntry });
  }

  // Priority lives on the events table, not loads — handle separately
  // so it covers relay legs (both pickup and delivery events get the
  // same flag) and doesn't fight the loads-table whitelist below.
  if (body.action === "set_priority" || body.action === "clear_priority") {
    const next = body.action === "set_priority";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase
      .from("events")
      .update({ priority: next } as any)
      .eq("load_id", loadId)
      .eq("org_id", orgId);
    if (error) {
      console.error("[PATCH /v1/closeout/loads/:id priority] failed:", error);
      return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
    return c.json({ ok: true });
  }

  const update: Record<string, unknown> = {};
  const now = new Date().toISOString();

  switch (body.action) {
    case "verify":
      update.billing_status = "verified";
      update.verified_at    = now;
      update.verified_by    = body.actorName ?? null;
      // Verifying clears any pending flag — dispatcher decided to
      // release anyway.
      update.flagged_at     = null;
      update.flagged_by     = null;
      update.flagged_reason = null;
      update.flagged_note   = null;
      break;
    case "flag":
      if (!body.flagReason) {
        return c.json({ error: "validation_failed", errors: ["flagReason required"] } satisfies ApiErrorResponse, 400);
      }
      update.billing_status = "on_hold";
      update.flagged_at     = now;
      update.flagged_by     = body.actorName ?? null;
      update.flagged_reason = body.flagReason;
      update.flagged_note   = body.flagNote ?? null;
      break;
    case "clear_flag":
      update.billing_status = "pending";
      update.flagged_at     = null;
      update.flagged_by     = null;
      update.flagged_reason = null;
      update.flagged_note   = null;
      break;
    case "set_invoice_docs":
      update.invoice_doc_ids = body.invoiceDocIds ?? [];
      break;
    case "mark_invoiced":
      update.billing_status = "invoiced";
      break;
    case "mark_paid":
      update.billing_status = "paid";
      break;
    case "reopen":
      update.billing_status = "pending";
      update.verified_at    = null;
      update.verified_by    = null;
      break;
    default:
      return c.json({ error: "validation_failed", errors: [`unknown action '${(body as { action?: string }).action}'`] } satisfies ApiErrorResponse, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase.from("loads").update(update as any).eq("id", loadId).eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/closeout/loads/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

export default closeout;
