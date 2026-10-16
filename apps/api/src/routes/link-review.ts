/**
 * /v1/link-review — reviewing how truck GPS was matched to the calendar
 * (docs/movement-linking.md).
 *
 *   GET  /?from=&to=&assetId=&confidence=&issue=&unreviewed=1
 *        legs with their GPS check (leg_actuals) + latest verdict / AI note
 *   POST /:eventId/review   { verdict, reason?, note? }  — a person's verdict
 *   POST /:eventId/explain  — ask the AI what happened (advisory)
 *   GET  /:eventId/trail    — the GPS drives linked to the load, for its map
 *
 * Verdicts are append-only rows in link_reviews with a snapshot of what was
 * reviewed; they're the training set for tuning the linker. Fixing a link
 * itself happens on the truck timeline (manual links), which the linker
 * never overwrites.
 */

import { Hono } from "hono";
import type {
  ApiErrorResponse, LinkAiSuggestion, LinkConfidence, LinkReviewEntry, LinkReviewItem,
  LinkReviewListResponse, LinkReviewReason, LinkReviewStop, LinkReviewVerdictRequest,
} from "@fleetcal/types";
import { supabase as supabaseTyped } from "../lib/supabase.js";
import { fetchAllRows } from "../lib/fetchAllRows.js";
import { getUserDisplayName } from "../lib/clerk.js";
import { explainLeg, LegNotFoundError } from "../lib/linkExplain.js";
import { loadTrail, TrailNotFoundError } from "../lib/loadTrail.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const linkReview = new Hono<{ Variables: AuthVariables }>();
// Same gate as the truck timeline this reviews.
linkReview.use("*", requireModule("performance"), requireCapability("loads.view"));

const REASONS: LinkReviewReason[] = ["wrong_truck", "stop_pin_wrong", "wrong_stop_matched", "calendar_time_wrong", "missing_stops", "miles_wrong", "other"];
const isDay = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v: unknown) => (v == null ? null : Number(v));

interface ReviewRow {
  id: string; event_id: string; kind: "human" | "ai"; verdict: "correct" | "wrong" | null;
  reason: string | null; note: string | null; suggestion: LinkAiSuggestion | null;
  created_by_name: string | null; created_at: string;
}
const toEntry = (r: ReviewRow): LinkReviewEntry => ({
  id: r.id, kind: r.kind, verdict: r.verdict, reason: r.reason, note: r.note,
  suggestion: r.suggestion, createdByName: r.created_by_name, createdAt: r.created_at,
});

linkReview.get("/", async (c) => {
  const orgId = c.get("orgId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isDay(from) || !isDay(to) || from! > to!) {
    return c.json({ error: "validation_failed", errors: ["from and to must be YYYY-MM-DD with from <= to"] } satisfies ApiErrorResponse, 400);
  }
  const assetId = c.req.query("assetId") ? Number(c.req.query("assetId")) : null;
  const confidence = (c.req.query("confidence") ?? "").split(",").filter(Boolean) as LinkConfidence[];
  const issue = c.req.query("issue") || null;
  const unreviewed = c.req.query("unreviewed") === "1";

  type Row = {
    event_id: string; load_id: string | null; asset_id: number | null; confidence: LinkConfidence; issues: string[];
    route_miles: number | null; loaded_miles: number | null; loaded_hours: number | null;
    deadhead_miles: number | null; deadhead_hours: number | null; return_miles: number | null; return_hours: number | null;
    dwell_hours: number | null; rest_hours: number | null; truck_start: string | null; truck_end: string | null;
    stops: LinkReviewStop[]; computed_at: string;
    events: { start: string; title: string | null; driver_name: string | null; event_kind: string; status: string | null; loads: { load_num: string | null } | null };
  };
  // Paged by hand: leg_actuals is keyed by event_id (no `id` column), so
  // fetchAllRows' ORDER BY id doesn't apply.
  const rows: Row[] = [];
  for (let off = 0; ; off += 1000) {
    let q = supabase
      .from("leg_actuals")
      .select("event_id, load_id, asset_id, confidence, issues, route_miles, loaded_miles, loaded_hours, deadhead_miles, deadhead_hours, return_miles, return_hours, dwell_hours, rest_hours, truck_start, truck_end, stops, computed_at, events!inner(start, title, driver_name, event_kind, status, deleted_at, loads(load_num))")
      .eq("org_id", orgId)
      .is("events.deleted_at", null)
      .gte("events.start", from)
      .lte("events.start", `${to}T23:59`);
    if (assetId != null && Number.isFinite(assetId)) q = q.eq("asset_id", assetId);
    const { data, error } = await q.order("event_id", { ascending: true }).range(off, off + 999);
    if (error) {
      console.error("[link-review list]", error);
      return c.json({ error: "leg_actuals_unavailable", detail: error.message } satisfies ApiErrorResponse, 409);
    }
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const live = rows.filter((r) => r.events.status !== "cancelled");

  const assets = await fetchAllRows<{ id: number; name: string }>("link review assets", () =>
    supabase.from("assets").select("id, name").eq("org_id", orgId));
  const assetName = new Map(assets.map((a) => [a.id, a.name]));

  // Latest human verdict and AI note per leg.
  let reviewsAvailable = true;
  const human = new Map<string, LinkReviewEntry>();
  const ai = new Map<string, LinkReviewEntry>();
  const ids = live.map((r) => r.event_id);
  for (let i = 0; i < ids.length && reviewsAvailable; i += 150) {
    try {
      const rv = await fetchAllRows<ReviewRow>("link reviews", () => supabase
        .from("link_reviews")
        .select("id, event_id, kind, verdict, reason, note, suggestion, created_by_name, created_at")
        .eq("org_id", orgId)
        .in("event_id", ids.slice(i, i + 150)));
      for (const r of rv) {
        const m = r.kind === "human" ? human : ai;
        const cur = m.get(r.event_id);
        if (!cur || cur.createdAt < r.created_at) m.set(r.event_id, toEntry(r));
      }
    } catch {
      reviewsAvailable = false; // link_reviews migration not run yet
    }
  }

  const all: LinkReviewItem[] = live.map((r) => ({
    eventId: r.event_id,
    loadId: r.load_id,
    loadNum: r.events.loads?.load_num ?? r.events.title ?? null,
    assetId: r.asset_id,
    truck: r.asset_id != null ? assetName.get(r.asset_id) ?? null : null,
    driverName: r.events.driver_name,
    start: r.events.start,
    revenue: r.events.event_kind === "revenue",
    confidence: r.confidence,
    issues: r.issues ?? [],
    routeMiles: num(r.route_miles),
    loadedMiles: num(r.loaded_miles), loadedHours: num(r.loaded_hours),
    deadheadMiles: num(r.deadhead_miles), deadheadHours: num(r.deadhead_hours),
    returnMiles: num(r.return_miles), returnHours: num(r.return_hours),
    dwellHours: num(r.dwell_hours), restHours: num(r.rest_hours),
    truckStart: r.truck_start, truckEnd: r.truck_end,
    stops: r.stops ?? [],
    computedAt: r.computed_at,
    review: human.get(r.event_id) ?? null,
    ai: ai.get(r.event_id) ?? null,
  }));

  const counts: LinkReviewListResponse["counts"] = { byConfidence: { high: 0, medium: 0, low: 0 }, byIssue: {}, reviewed: 0 };
  for (const it of all) {
    counts.byConfidence[it.confidence]++;
    for (const i of it.issues) counts.byIssue[i] = (counts.byIssue[i] ?? 0) + 1;
    if (it.review) counts.reviewed++;
  }
  const items = all
    .filter((it) => !confidence.length || confidence.includes(it.confidence))
    .filter((it) => !issue || it.issues.includes(issue))
    .filter((it) => !unreviewed || !it.review)
    .sort((a, b) => a.start.localeCompare(b.start));

  return c.json({ items, counts, reviewsAvailable } satisfies LinkReviewListResponse);
});

linkReview.post("/:eventId/review", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const eventId = c.req.param("eventId");
  const body = (await c.req.json().catch(() => null)) as LinkReviewVerdictRequest | null;
  const errors: string[] = [];
  if (!body || (body.verdict !== "correct" && body.verdict !== "wrong")) errors.push("verdict must be 'correct' or 'wrong'");
  if (body?.reason != null && !REASONS.includes(body.reason)) errors.push(`reason must be one of ${REASONS.join(", ")}`);
  if (body?.note != null && (typeof body.note !== "string" || body.note.length > 2000)) errors.push("note must be text up to 2000 characters");
  if (errors.length) return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);

  const { data: leg } = await supabase.from("leg_actuals").select("*").eq("org_id", orgId).eq("event_id", eventId).maybeSingle();
  if (!leg) return c.json({ error: "not_found", detail: "No GPS check for this leg yet" } satisfies ApiErrorResponse, 404);

  const { data, error } = await supabase.from("link_reviews").insert({
    org_id: orgId,
    event_id: eventId,
    kind: "human",
    verdict: body!.verdict,
    reason: body!.verdict === "wrong" ? body!.reason ?? "other" : null,
    note: body!.note?.trim() || null,
    snapshot: leg,
    created_by: userId,
    created_by_name: await getUserDisplayName(userId).catch(() => null),
  }).select("id, event_id, kind, verdict, reason, note, suggestion, created_by_name, created_at").single();
  if (error) {
    return c.json({ error: "review_save_failed", detail: `${error.message} — has 20261016b_link_reviews.sql been run?` } satisfies ApiErrorResponse, 409);
  }
  return c.json({ review: toEntry(data as ReviewRow) });
});

linkReview.post("/:eventId/explain", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const eventId = c.req.param("eventId");
  let result: Awaited<ReturnType<typeof explainLeg>>;
  try {
    result = await explainLeg(orgId, eventId);
  } catch (err) {
    if (err instanceof LegNotFoundError) return c.json({ error: "not_found", detail: err.message } satisfies ApiErrorResponse, 404);
    console.error("[link-review explain]", err);
    return c.json({ error: "explain_failed", detail: err instanceof Error ? err.message : String(err) } satisfies ApiErrorResponse, 502);
  }
  const row = {
    org_id: orgId, event_id: eventId, kind: "ai", verdict: null, reason: result.suggestion.cause, note: null,
    suggestion: result.suggestion, snapshot: result.snapshot, created_by: userId, created_by_name: null,
  };
  const { data, error } = await supabase.from("link_reviews").insert(row)
    .select("id, event_id, kind, verdict, reason, note, suggestion, created_by_name, created_at").single();
  // Still return the explanation if it can't be stored (migration not run).
  const entry: LinkReviewEntry = error
    ? { id: "", kind: "ai", verdict: null, reason: result.suggestion.cause, note: null, suggestion: result.suggestion, createdByName: null, createdAt: new Date().toISOString() }
    : toEntry(data as ReviewRow);
  return c.json({ ai: entry });
});

linkReview.get("/:eventId/trail", async (c) => {
  try {
    return c.json(await loadTrail(c.get("orgId"), c.req.param("eventId")));
  } catch (err) {
    if (err instanceof TrailNotFoundError) return c.json({ error: "not_found", detail: err.message } satisfies ApiErrorResponse, 404);
    console.error("[link-review trail]", err);
    return c.json({ error: "trail_failed", detail: err instanceof Error ? err.message : String(err) } satisfies ApiErrorResponse, 500);
  }
});

export default linkReview;
