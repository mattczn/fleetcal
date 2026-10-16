/**
 * "Ask AI" for one leg on the link-review surface: hands Claude what the
 * calendar says, what the truck's GPS actually did around it, the loads on
 * either side, and the reviewer's past corrections, and gets back a short
 * plain-English explanation with a likely cause and a suggested fix.
 *
 * Advisory only — nothing is written to links or the calendar; a person
 * decides. See docs/movement-linking.md.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LinkAiCause, LinkAiSuggestion, LinkConfidence } from "@fleetcal/types";
import { env } from "./env.js";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { getHosConfig } from "./hosService.js";
import { wallClockToUtc } from "./movementLinkerData.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
export const LINK_EXPLAIN_MODEL = "claude-opus-5-5";

const CAUSES: LinkAiCause[] = [
  "truck_swap", "stop_pin_wrong", "calendar_time_off", "missing_stops", "consolidated_loads",
  "gps_off", "detour_or_errand", "linking_error", "looks_correct", "unclear",
];

const SYSTEM = `You help a trucking dispatcher check how a truck's GPS was matched to their dispatch calendar.

How the system works:
- The calendar is the source of truth. Every paid driver movement is on it, so the truck on a calendar load is almost always right, and the time of day is approximate (often an hour or two off, sometimes a placeholder).
- A rules engine lines up ONE truck's Motive GPS against THAT truck's calendar stops, in order. A stop is "found" when the truck sat within about 1 mile of the stop's map pin near the calendar time (up to 3 miles and 36 hours with a penalty).
- Driving between a load's pickup and delivery is loaded; delivery to the next pickup is deadhead for the next load; driving to the yard (or a driver's parking spot) after the last load is that load's return.
- Loads can be relayed: one truck takes a trailer to a handoff point (a yard or relay point), another truck continues. Each truck's leg is checked separately.
- Several loads can be on the truck at once (e.g. multiple pickups consolidated into one DHL delivery).
- The ELD sometimes disconnects; the truck then "reappears" somewhere else with odometer miles but no GPS in between.

Each leg arrives with issues found by the rules:
- stop_not_found: the truck never sat near that stop's pin in the time window.
- stop_out_of_order: it did, but not in the order the calendar puts it in.
- gps_gap: the calendar time falls while the ELD was off.
- no_stops: the load was saved without any stops (a data problem in the app).
- miles_mismatch: GPS loaded miles are far from the routed miles.
- detour: empty driving was much longer than the straight shot (an errand, a stop at home, or an unlisted stop).
- no_gps: the truck has no ELD.
"Other trucks there" lists trucks that sat at the stop around the calendar time — exactly one usually means the load physically changed trucks and the calendar wasn't updated.

Pick the single most likely cause:
- truck_swap: another truck did (part of) this load; name it in suggestedTruck.
- stop_pin_wrong: the truck clearly went to the facility but the pin is off (it sat 1–10 mi away at the right time, every visit).
- calendar_time_off: the truck did the stops, just at very different times than the calendar.
- missing_stops: the calendar is missing stops (or has none), so the GPS can't be explained.
- consolidated_loads: the truck carried this with another load at the same time.
- gps_off: the ELD was off during the load.
- detour_or_errand: the load matches; the extra miles are an unlisted stop or errand.
- linking_error: the GPS and calendar agree but the rules matched the wrong visit.
- looks_correct: nothing is actually wrong.
- unclear: the evidence doesn't support any of the above — say what would settle it.

Write for a busy dispatcher: plain words, specific times and places from the evidence, no jargon. "summary": 1–3 sentences on what the GPS shows versus the calendar. "fix": one or two sentences on what to change (e.g. "Change the truck on this load to CT-2028", "Move the pin for ADMIRAL BEVERAGE to where trucks actually park"), or "Nothing to fix". "suggestedTruck": the truck name for truck_swap, otherwise an empty string. Be honest about uncertainty through "confidence". Past reviewer corrections, when given, show how this dispatcher sees their own operation — weigh them.`;

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    cause: { type: "string", enum: CAUSES },
    fix: { type: "string" },
    suggestedTruck: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["summary", "cause", "fix", "suggestedTruck", "confidence"],
  additionalProperties: false,
} as const;

interface LegRow {
  event_id: string; asset_id: number | null; confidence: string; issues: string[];
  route_miles: number | null; loaded_miles: number | null; deadhead_miles: number | null; return_miles: number | null;
  dwell_hours: number | null; rest_hours: number | null; truck_start: string | null; truck_end: string | null;
  stops: Array<{ label: string; kind: string; arrive: string | null; depart: string | null; distMi: number | null; offH: number | null;
    issue: string | null; nearest: { distMi: number; offH: number; at: string | null } | null;
    otherTrucks: Array<{ name: string; arrive: string | null }> }>;
}

export class LegNotFoundError extends Error {}

/** Builds the evidence, asks Claude, returns the parsed suggestion and the leg row it was based on. */
export async function explainLeg(orgId: string, eventId: string): Promise<{ suggestion: LinkAiSuggestion; snapshot: LegRow }> {
  const { data: leg } = await supabase.from("leg_actuals").select("*").eq("org_id", orgId).eq("event_id", eventId).maybeSingle();
  if (!leg) throw new LegNotFoundError("No GPS check for this leg yet");
  const row = leg as LegRow;

  const { timeZone } = await getHosConfig(orgId);
  const local = (iso: string | null | undefined) => iso
    ? new Date(iso).toLocaleString("en-US", { timeZone, weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";

  const { data: ev } = await supabase
    .from("events")
    .select("id, start, end, title, driver_name, asset_id, leg_index, event_kind, loaded_miles, loads(load_num, broker)")
    .eq("org_id", orgId).eq("id", eventId).maybeSingle();
  if (!ev) throw new LegNotFoundError("Calendar entry not found");

  const assetId = ev.asset_id as number | null;
  const [assets, saved] = await Promise.all([
    fetchAllRows<{ id: number; name: string }>("explain assets", () => supabase.from("assets").select("id, name").eq("org_id", orgId)),
    fetchAllRows<{ name: string; lat: number; lng: number }>("explain places", () => supabase.from("saved_locations").select("name, lat, lng").eq("org_id", orgId)),
  ]);
  const truckName = assets.find((a) => a.id === assetId)?.name ?? "unknown truck";

  // Window: the truck's time on the leg (or the calendar entry) ± 12 h.
  const startMs = row.truck_start ? Date.parse(row.truck_start) : wallClockToUtc(ev.start, timeZone) ?? Date.now();
  const endMs = row.truck_end ? Date.parse(row.truck_end) : wallClockToUtc(ev.end, timeZone) ?? startMs;
  const fromIso = new Date(startMs - 12 * 3_600_000).toISOString();
  const toIso = new Date(endMs + 12 * 3_600_000).toISOString();

  const [moves, nearby] = await Promise.all([
    assetId == null ? Promise.resolve([]) : fetchAllRows<{ start_time: string; end_time: string | null; miles: number | null; destination: string | null }>(
      "explain movements", () => supabase.from("movements")
        .select("start_time, end_time, miles, destination")
        .eq("org_id", orgId).eq("asset_id", assetId).is("deleted_at", null)
        .gte("start_time", fromIso).lt("start_time", toIso)),
    assetId == null ? Promise.resolve([]) : fetchAllRows<{ id: string; start: string; end: string; title: string | null; event_kind: string; loads: { load_num: string | null } | null }>(
      "explain nearby events", () => supabase.from("events")
        .select("id, start, end, title, event_kind, loads(load_num)")
        .eq("org_id", orgId).eq("asset_id", assetId).is("deleted_at", null)
        .lt("start", toIso.slice(0, 16)).gt("end", fromIso.slice(0, 16))),
  ]);
  const nearbyIds = nearby.map((e) => e.id);
  const nearbyStops = nearbyIds.length ? await fetchAllRows<{ event_id: string; sequence: number; type: string; facility_name: string | null; city: string | null; state: string | null; appt_start: string | null }>(
    "explain stops", () => supabase.from("stops").select("event_id, sequence, type, facility_name, city, state, appt_start").in("event_id", nearbyIds)) : [];

  const gpsLines: string[] = [];
  const sorted = [...moves].sort((a, b) => a.start_time.localeCompare(b.start_time)).filter((m) => (m.miles ?? 0) >= 0.5);
  sorted.forEach((m, i) => {
    gpsLines.push(`${local(m.start_time)} → ${local(m.end_time)}  drove ${Number(m.miles ?? 0).toFixed(0)} mi to ${m.destination || "?"}`);
    const next = sorted[i + 1];
    if (next && m.end_time) {
      const h = (Date.parse(next.start_time) - Date.parse(m.end_time)) / 3_600_000;
      if (h >= 0.5) gpsLines.push(`    parked ${h.toFixed(1)} h`);
    }
  });

  const calLines = nearby
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => {
      const st = nearbyStops.filter((s) => s.event_id === e.id).sort((a, b) => a.sequence - b.sequence)
        .map((s) => `${s.type} ${s.facility_name ?? ""} (${[s.city, s.state].filter(Boolean).join(", ")})${s.appt_start ? ` appt ${s.appt_start.replace("T", " ")}` : ""}`);
      const mark = e.id === eventId ? "  ← THIS LEG" : "";
      return `${e.start.replace("T", " ")} – ${e.end.replace("T", " ")}  #${e.loads?.load_num ?? e.title ?? "?"} ${e.event_kind === "non_revenue" ? "(non-revenue) " : ""}${mark}\n    ${st.join("\n    ") || "(no stops)"}`;
    });

  const stopLines = row.stops.map((s) => {
    const found = s.arrive
      ? `GPS: arrived ${local(s.arrive)}, left ${local(s.depart)}, ${s.distMi ?? "?"} mi from the pin, ${s.offH ?? "?"} h outside the calendar time`
      : `NOT FOUND (${s.issue})${s.nearest ? `; closest the truck got: ${s.nearest.distMi} mi, ${s.nearest.offH} h from the calendar time, at ${local(s.nearest.at)}` : ""}`;
    const others = s.otherTrucks?.length ? `; other trucks there: ${s.otherTrucks.map((o) => `${o.name} at ${local(o.arrive)}`).join(", ")}` : "";
    return `- ${s.label}: ${found}${others}`;
  });

  // The reviewer's recent corrections — how they read their own operation.
  const { data: past } = await supabase
    .from("link_reviews")
    .select("reason, note, snapshot, created_at")
    .eq("org_id", orgId).eq("kind", "human").eq("verdict", "wrong")
    .order("created_at", { ascending: false }).limit(8);
  const pastLines = ((past ?? []) as Array<{ reason: string | null; note: string | null; snapshot: { issues?: string[] } }>)
    .filter((p) => p.note || p.reason)
    .map((p) => `- ${p.reason ?? "wrong"}${p.snapshot?.issues?.length ? ` (rules flagged: ${p.snapshot.issues.join(", ")})` : ""}: ${p.note ?? ""}`);

  const content = [
    `Truck ${truckName}, driver ${ev.driver_name ?? "?"}. Times are ${timeZone}.`,
    `Leg: #${ev.loads?.load_num ?? ev.title ?? "?"} (${ev.loads?.broker ?? "no broker"}), calendar ${String(ev.start).replace("T", " ")} – ${String(ev.end).replace("T", " ")}${ev.leg_index ? `, relay leg ${ev.leg_index + 1}` : ""}.`,
    `Rules result: ${row.confidence} confidence; issues: ${row.issues.join(", ") || "none"}.`,
    `Miles: GPS loaded ${row.loaded_miles ?? "?"} vs routed ${row.route_miles ?? "?"}; deadhead in ${row.deadhead_miles ?? 0}; return ${row.return_miles ?? 0}. Dwell ${row.dwell_hours ?? 0} h, rest ${row.rest_hours ?? 0} h.`,
    ``,
    `Stops on this leg:`,
    ...stopLines,
    ``,
    `This truck's calendar around the leg:`,
    ...(calLines.length ? calLines : ["(nothing else)"]),
    ``,
    `This truck's GPS from 12 h before to 12 h after:`,
    ...(gpsLines.length ? gpsLines.slice(0, 120) : ["(no GPS)"]),
    ``,
    `Known places: ${saved.map((p) => p.name).join(", ") || "none"}.`,
    ...(pastLines.length ? [``, `Past reviewer corrections:`, ...pastLines] : []),
  ].join("\n");

  // `fallbacks` (server-side refusal fallback) isn't in this SDK version's
  // types yet; a non-literal params object carries it through.
  const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming & { fallbacks: "default" } = {
    model: LINK_EXPLAIN_MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content }],
  };
  const res = await anthropic.beta.messages.create(params);
  if (res.stop_reason === "refusal") throw new Error("The AI declined to explain this leg");
  const text = res.content.find((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")?.text ?? "";
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text); } catch { throw new Error("The AI's answer wasn't readable — try again"); }

  const cause = CAUSES.includes(parsed.cause as LinkAiCause) ? (parsed.cause as LinkAiCause) : "unclear";
  const confidence = (["high", "medium", "low"] as const).includes(parsed.confidence as LinkConfidence)
    ? (parsed.confidence as LinkConfidence) : "low";
  return {
    suggestion: {
      summary: String(parsed.summary ?? ""),
      cause,
      fix: String(parsed.fix ?? ""),
      suggestedTruck: String(parsed.suggestedTruck ?? ""),
      confidence,
      model: res.model,
    },
    snapshot: row,
  };
}
