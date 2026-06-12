/**
 * Read-only load endpoints for the Telegram bot.
 * Mounted under /v1/bot/loads via botAuth middleware (no Clerk required).
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { DocumentBlockParam, TextBlockParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { joinEventLoadToApp, type ListLoadsResponse, type ApiErrorResponse, type Load, type LoadStatus, LOAD_STATUSES, type Stop, type StopType } from "@fleetcal/types";
import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";
import type { AuthVariables } from "../middleware/clerk.js";

const botLoads = new Hono<{ Variables: AuthVariables }>();
const ANTHROPIC_CLIENT = new Anthropic({ apiKey: env.anthropicApiKey });
// pdf_extractions isn't in the generated Database types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at," +
  "confirmed_at,confirmed_by,confirm_reminder_sent_at";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,total_billable,commodity,weight," +
  "dispatcher,notes,internal_notes," +
  "accessorials,rate_con_pdf,ref_nums," +
  "billing_status,flagged_reason,flagged_note,flagged_at,flagged_by," +
  "verified_at,verified_by,invoice_doc_ids," +
  "document_counts,audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

interface StopRow {
  id: string;
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
  appt_start: string | null;
  appt_end: string | null;
  schedule_type: string | null;
  instructions: string | null;
  geocode_status: string | null;
  arrived_at: string | null;
  arrived_lat: number | null;
  arrived_lng: number | null;
}

function rowToStop(s: StopRow): Stop {
  return {
    id: s.id,
    eventId: s.event_id,
    sequence: s.sequence,
    type: s.type as StopType,
    facilityName: s.facility_name ?? undefined,
    address: s.address ?? undefined,
    city: s.city ?? undefined,
    state: s.state ?? undefined,
    lat: s.lat ?? undefined,
    lng: s.lng ?? undefined,
    timezone: s.timezone ?? undefined,
    apptStart: s.appt_start ?? undefined,
    apptEnd: s.appt_end ?? undefined,
    scheduleType: (s.schedule_type as Stop["scheduleType"]) ?? undefined,
    instructions: s.instructions ?? undefined,
    geocodeStatus: (s.geocode_status as Stop["geocodeStatus"]) ?? "pending",
  };
}

// GET /v1/bot/loads — list loads with optional filters
botLoads.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const statusParam = url.searchParams.get("status");

  let statusList: LoadStatus[] | undefined;
  if (statusParam) {
    const parts = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = parts.filter((s) => !LOAD_STATUSES.includes(s as LoadStatus));
    if (invalid.length) {
      return c.json({ error: "bad_request", detail: `unknown status: ${invalid.join(",")}` } satisfies ApiErrorResponse, 400);
    }
    statusList = parts as LoadStatus[];
  }

  let q = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start", { ascending: true });

  if (from) q = q.gte("end", from);
  if (to) q = q.lte("start", to);
  if (statusList) q = q.in("status", statusList);

  const { data: events, error } = await q;
  if (error) {
    console.error("[GET /v1/bot/loads] query failed:", error);
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const rows = events ?? [];
  const eventIds = (rows as Array<Record<string, unknown>>).map((r) => r.id as string);
  const stopsByEvent = new Map<string, Stop[]>();

  if (eventIds.length) {
    const { data: stopRows } = await supabase
      .from("stops")
      .select(STOP_COLS)
      .in("event_id", eventIds);
    for (const s of (stopRows ?? []) as unknown as StopRow[]) {
      const arr = stopsByEvent.get(s.event_id) ?? [];
      arr.push(rowToStop(s));
      stopsByEvent.set(s.event_id, arr);
    }
  }

  const result: Load[] = rows.map((e) => {
    const ev = e as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(joined.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    return joined;
  });

  return c.json({ loads: result } satisfies ListLoadsResponse);
});

// GET /v1/bot/loads/search — search by load number or driver name
// Core load search by a single query string. Matches load_num,
// internal_load_id, broker, ref_nums (the broker's reference numbers),
// and event title / driver_name. Returns one row per load (pickup leg
// for relays). Shared by GET /search and POST /search-pdf.
async function findLoadsByQuery(orgId: string, q: string, limit: number): Promise<Load[]> {
  const isNumeric = /^\d+$/.test(q);
  // Escape PostgREST .or() control chars (% , ( )).
  const qEsc = q.replace(/[%,()]/g, "\\$&");

  const { data: matchedLoads } = await supabase
    .from("loads").select("id").eq("org_id", orgId).is("deleted_at", null)
    .or(`load_num.ilike.%${qEsc}%,broker.ilike.%${qEsc}%`);

  // internal_load_id is an INTEGER column. Comparing it to a leading-zero
  // broker order number (".eq.0015997") makes Postgres coerce the string to
  // 15997 and match a completely unrelated load. Compare as text so only a
  // true match counts (and a real FleetCal id search still works).
  const { data: idMatches } = isNumeric
    ? await supabase
        .from("loads").select("id").eq("org_id", orgId).is("deleted_at", null)
        .filter("internal_load_id::text", "eq", q)
    : { data: [] as Array<{ id: string }> };

  // ref_nums (jsonb) — PostgREST .or() can't take a ::text cast, so a
  // separate query (same approach as loads.ts /search).
  const { data: refMatches } = await supabase
    .from("loads").select("id").eq("org_id", orgId).is("deleted_at", null)
    .filter("ref_nums::text", "ilike", `%${qEsc}%`);

  const loadIds = [...new Set([
    ...((matchedLoads ?? []) as Array<{ id: string }>).map((r) => r.id),
    ...((idMatches     ?? []) as Array<{ id: string }>).map((r) => r.id),
    ...((refMatches   ?? []) as Array<{ id: string }>).map((r) => r.id),
  ])];

  const { data: matchedEvents } = await supabase
    .from("events").select("id").eq("org_id", orgId).is("deleted_at", null)
    .or(`title.ilike.%${qEsc}%,driver_name.ilike.%${qEsc}%`);
  const eventIds = new Set(((matchedEvents ?? []) as Array<{ id: string }>).map((r) => r.id));

  let evQ = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId).is("deleted_at", null)
    .order("start", { ascending: false }).limit(limit);

  if (loadIds.length && eventIds.size) {
    evQ = evQ.or(`id.in.(${Array.from(eventIds).join(",")}),load_id.in.(${loadIds.join(",")})`);
  } else if (loadIds.length) {
    evQ = evQ.in("load_id", loadIds);
  } else if (eventIds.size) {
    evQ = evQ.in("id", Array.from(eventIds));
  } else {
    return [];
  }

  const { data: events, error } = await evQ;
  if (error) { console.error("[bot findLoadsByQuery] failed:", error); return []; }

  // Does this load's OWN identity actually equal the query? A substring/jsonb
  // ilike (or a coincidental id) can surface unrelated loads — only an exact
  // hit on the load number, internal id, or a stored ref number is safe to
  // auto-link. Caller decides what to do with fuzzy (matchExact=false) hits.
  const qn = normRef(q);
  const isExact = (load: Load): boolean => {
    if (!qn) return false;
    // Broker-facing identifiers only: the load number or a stored ref number.
    // NOT internal_load_id — it's FleetCal's sequential id, which a stray
    // number in an email (phone, date, tracking #) collides with, producing
    // wrong auto-links in the Gmail extension. (It stays searchable above.)
    if (load.loadNum && normRef(load.loadNum) === qn) return true;
    if (Array.isArray(load.refNums) && load.refNums.some((r) => normRef(r?.value) === qn)) return true;
    return false;
  };

  const result: Array<Load & { matchExact?: boolean }> = (events ?? []).map((e) => {
    const ev = e as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow) as Load & { matchExact?: boolean };
    joined.stops = [];
    joined.matchExact = isExact(joined);
    return joined;
  });

  // dedupe relay legs — one per loadId, preferring the pickup leg. An exact
  // hit on either leg makes the load exact.
  const byLoad = new Map<string, Load & { matchExact?: boolean }>();
  for (const l of result) {
    const key = l.loadId ?? l.id;
    const existing = byLoad.get(key);
    if (!existing) { byLoad.set(key, l); continue; }
    if (l.matchExact) existing.matchExact = true;
    if (l.relayRole === "pickup" && existing.relayRole !== "pickup") {
      l.matchExact = l.matchExact || existing.matchExact;
      byLoad.set(key, l);
    }
  }
  // Exact matches first so callers can trust loads[0].
  return [...byLoad.values()].sort((a, b) => Number(b.matchExact) - Number(a.matchExact));
}

// Normalize a reference for exact comparison: upper-case, strip spaces and
// dashes. Keeps leading zeros (so "0015997" ≠ "15997").
function normRef(s: unknown): string {
  return String(s ?? "").toUpperCase().replace(/[\s-]/g, "");
}

botLoads.get("/search", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 50);
  if (q.length < 2) return c.json({ loads: [] } satisfies ListLoadsResponse);
  const loads = await findLoadsByQuery(orgId, q, limit);
  return c.json({ loads } satisfies ListLoadsResponse);
});

// ── POST /search-pdf — find a load from a rate-con PDF ──────────────────
// For New Load emails whose load number is ONLY in the attached rate con
// (nothing in the subject/body). Claude (Haiku) pulls the candidate
// reference numbers out of the PDF; we search each. Returns the same
// { matches: [{ ref, loads }] } shape the extension's text search uses.
botLoads.post("/search-pdf", async (c) => {
  const orgId = c.get("orgId");
  let body: { pdfBase64?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad_json" }, 400); }
  const base64 = (body.pdfBase64 || "").trim();
  if (!base64) return c.json({ error: "pdfBase64 required" }, 400);

  // Content-hash cache: the same rate con lands in every dispatcher's inbox,
  // so AI-extract it once per unique PDF (org-wide), not once per mailbox.
  const hash = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

  let refs: string[] = [];
  let cacheHit = false;
  try {
    const { data: cached } = await sb
      .from("pdf_extractions")
      .select("refs")
      .eq("org_id", orgId)
      .eq("pdf_sha256", hash)
      .maybeSingle();
    if (cached && Array.isArray(cached.refs)) {
      refs = cached.refs as string[];
      cacheHit = true;
    } else {
      refs = await extractRefsFromPdf(base64);
      // Best-effort store — don't fail the request if the cache write errors.
      await sb.from("pdf_extractions")
        .upsert({ org_id: orgId, pdf_sha256: hash, refs } as Record<string, unknown>,
                { onConflict: "org_id,pdf_sha256" });
    }
  } catch (err) {
    console.error("[POST /v1/bot/loads/search-pdf] extraction failed:", err);
    return c.json({ error: "extract_failed", refs: [], matches: [] }, 200);
  }

  const matches: Array<{ ref: string; loads: Load[] }> = [];
  for (const ref of refs) {
    if (ref.trim().length < 2) continue;
    const loads = await findLoadsByQuery(orgId, ref.trim(), 5);
    if (loads.length) matches.push({ ref, loads });
  }
  return c.json({ refs, matches, cached: cacheHit });
});

// Claude reference-number extraction from a rate-con PDF. Cheap (Haiku,
// small JSON out). Returns the most-likely-primary identifiers first.
async function extractRefsFromPdf(base64: string): Promise<string[]> {
  const docBlock: DocumentBlockParam = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: base64 },
  };
  const prompt =
    "This is a freight rate confirmation / load tender PDF. Extract EVERY " +
    "identifier a carrier would use to find this load: load number, " +
    "reference number, order number, PO number, BOL number, shipment id, " +
    "confirmation number, pro number. Return ONLY a JSON array of strings " +
    "(the raw identifiers, no labels), most-likely primary first. If none, " +
    "return []. No prose.";
  const textBlock: TextBlockParam = { type: "text", text: prompt };
  const resp = await ANTHROPIC_CLIENT.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages:   [{ role: "user", content: [docBlock, textBlock] as ContentBlockParam[] }],
  });
  const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean).slice(0, 12) : [];
  } catch { return []; }
}

export default botLoads;
