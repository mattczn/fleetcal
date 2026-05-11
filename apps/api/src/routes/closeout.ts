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

const closeout = new Hono<{ Variables: AuthVariables }>();

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,commodity,weight," +
  "dispatcher,notes,internal_notes," +
  "accessorials,rate_con_pdf,ref_nums," +
  "billing_status,flagged_reason,flagged_note,flagged_at,flagged_by," +
  "verified_at,verified_by,invoice_doc_ids," +
  "audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

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

  // When searching by load-level fields, PostgREST's .or() can't span
  // a foreign relation in one shot. Mirror the /v1/loads/search pattern:
  // first resolve matching load ids from the loads table, then OR that
  // set with event-level field matches in the main query.
  let searchLoadIds: string[] | null = null;
  let searchEventOr: string | null = null;
  if (searching) {
    // Escape PostgREST-special chars in the LIKE pattern.
    const escaped = qRaw.replace(/[%,()]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const parsedNum = /^\d+$/.test(qRaw) ? Number(qRaw) : NaN;
    const numericId = Number.isFinite(parsedNum) && parsedNum <= 2147483647 ? parsedNum : null;
    const loadOr = numericId !== null
      ? `internal_load_id.eq.${numericId},load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`
      : `load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`;
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
    searchLoadIds = ((loadIdRows ?? []) as Array<{ id: string }>).map(r => r.id);
    // Event-level OR — title / driver_name / notes plus the load_id set
    // (when non-empty). If neither matches, no rows pass the filter, so
    // we still emit a no-op OR to short-circuit cleanly.
    const eventOrParts: string[] = [
      `title.ilike.${pattern}`,
      `driver_name.ilike.${pattern}`,
      `notes.ilike.${pattern}`,
    ];
    if (searchLoadIds.length > 0) eventOrParts.push(`load_id.in.(${searchLoadIds.join(",")})`);
    searchEventOr = eventOrParts.join(",");
  }

  let query = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads!inner(${LOAD_COLS})`, { count: "exact" })
    .eq("org_id", orgId)
    .eq("event_kind", "revenue")
    .is("deleted_at", null)
    .neq("status", "cancelled");

  if (tab === "pending") {
    // Anything still in the queue: due (end <= now), not yet released,
    // and not currently flagged. Cancelled is already excluded above.
    // When searching, drop the end-date constraint so upcoming loads
    // are reachable — the search is the working filter then, not date.
    if (!searching) query = query.lte("end", nowIso);
    query = query.eq("load.billing_status", "pending");
  } else if (tab === "flagged") {
    query = query.eq("load.billing_status", "on_hold");
  } else if (tab === "verified") {
    query = query.eq("load.billing_status", "verified");
  } else if (tab === "invoiced") {
    query = query.eq("load.billing_status", "invoiced");
  } else if (tab === "paid") {
    query = query.eq("load.billing_status", "paid");
  }
  // "all" — no extra filter.

  if (searchEventOr) {
    query = query.or(searchEventOr);
  }

  // Priority loads always pin to the top of every page so dispatchers
  // see them first regardless of which page they're paginating through.
  // Within priority and non-priority groups, oldest end-date first.
  const { data, error, count } = await query
    .order("priority", { ascending: false })
    .order("end",      { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) {
    console.error("[GET /v1/closeout/queue] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loads: Load[] = (data ?? []).map((row: any) => joinEventLoadToApp(row, row.load));

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
    total: count ?? loads.length,
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
    | "append_note";
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
