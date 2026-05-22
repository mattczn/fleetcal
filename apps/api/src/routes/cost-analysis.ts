/**
 * /v1/cost-analysis — experimental Claude-powered cost-per-load
 * reasoning. Takes a Motive vehicle id and a date range, joins the
 * driving-period telemetry to the load schedule for that vehicle's
 * asset, sends the merged context to Claude Sonnet, and asks for a
 * per-load breakdown of loaded vs deadhead miles + true RPM.
 *
 * v1 scope:
 *   - One week per call
 *   - On-demand only (no caching of results — every request re-runs)
 *   - Structured output via forced tool use so the response is
 *     reliably parseable for the UI table
 *   - Surfaces the model's reasoning so dispatchers can audit matches
 *
 * Not a feature, an experiment — we want to see how well this works
 * before investing in caching/persistence/UI polish.
 */

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });
const MODEL  = "claude-sonnet-4-5-20250929";

const costAnalysis = new Hono<{ Variables: AuthVariables }>();

const SYSTEM_PROMPT = `You are analyzing a trucking dispatcher's data to figure out the *true* cost-per-mile per load.

Two data streams will be provided for one truck over a date range:

1. SCHEDULED LOADS — what dispatch booked: load id, customer, pickup/delivery stops with addresses + appointment times, price, loaded-mile estimate. These are the "revenue" segments.

2. TELEMETRY MOVEMENTS — what the truck actually did: each driving period from the ELD with start/end timestamp, origin + destination text, miles driven, duration. These are the "ground truth" of where the truck went.

Your job is to match movements to loads, account for the empty miles around each load, and report a per-load cost picture. Definitions you should use:

- **Loaded miles**: the truck-movement miles that happened *under* a scheduled load (between pickup and delivery for that load). Match by time + geography.
- **Deadhead before**: miles the truck moved *to position itself* for this load's pickup (from wherever it dropped its prior load, OR from a home/yard, to the pickup point).
- **Deadhead after**: miles to the *next* load's pickup, OR back to a home/yard, *only if* there is no next load and the truck returned to base.
- **Return home**: a special case of deadhead-after where the truck went back to a home base (typically the last movement of the week).
- **Stated RPM** = load_price / loaded_miles (what dispatch sees on the rate-con)
- **True RPM** = load_price / (loaded_miles + deadhead_before + apportioned_return_home) — the real cost-per-mile including positioning.

You must:
- Be conservative. Mark confidence "low" when the time/geography evidence is weak.
- Account for *every* movement — either it belongs to a load, or it's labeled in unmatchedMovements as positioning, return_home, personal, or unknown.
- Avoid double-counting miles. A movement belongs to at most one bucket.
- Output via the submit_analysis tool. Don't write prose outside the tool.

When you reason, look for:
- Movement times that fall between a load's pickup-time and delivery-time
- Movement origin/destination cities that match the load's pickup/delivery cities
- Gaps between loads where the truck moved → that's positioning
- The last movement of the window with no next load → likely return-home
`;

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: "submit_analysis",
  description: "Submit the per-load cost analysis as structured output.",
  input_schema: {
    type: "object",
    properties: {
      loads: {
        type: "array",
        description: "One entry per scheduled load that fell inside the window.",
        items: {
          type: "object",
          properties: {
            loadId:               { type: "string",  description: "The load id from the input." },
            loadLabel:            { type: "string",  description: "Brief human label e.g. 'Provo UT → Cheyenne WY'." },
            confidence:           { type: "string",  enum: ["high", "medium", "low"] },
            matchedMovementIds:   { type: "array",   items: { type: "number" }, description: "Motive driving_period ids that map to this load's loaded miles." },
            loadedMiles:          { type: "number" },
            deadheadMilesBefore:  { type: "number", description: "Positioning miles to reach pickup." },
            deadheadMilesAfter:   { type: "number", description: "Miles after delivery toward the next load's pickup OR home. 0 if no movement after." },
            revenue:              { type: "number", description: "Load price in dollars." },
            statedRpm:            { type: "number", description: "revenue / loadedMiles. Two decimal places." },
            trueRpm:              { type: "number", description: "revenue / (loadedMiles + deadheadMilesBefore + deadheadMilesAfter). Two decimal places." },
            reasoning:            { type: "string", description: "Plain-English one-paragraph explanation of how you matched and where the deadhead came from." },
          },
          required: ["loadId", "loadLabel", "confidence", "matchedMovementIds", "loadedMiles", "deadheadMilesBefore", "deadheadMilesAfter", "revenue", "statedRpm", "trueRpm", "reasoning"],
        },
      },
      unmatchedMovements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            movementId:    { type: "number" },
            likelyPurpose: { type: "string", enum: ["positioning", "return_home", "personal", "unknown"] },
            miles:         { type: "number" },
            reasoning:     { type: "string" },
          },
          required: ["movementId", "likelyPurpose", "miles", "reasoning"],
        },
      },
      summary: {
        type: "object",
        properties: {
          totalRevenue:       { type: "number" },
          totalLoadedMiles:   { type: "number" },
          totalDeadheadMiles: { type: "number" },
          totalReturnHomeMiles: { type: "number" },
          fleetTrueRpm:       { type: "number", description: "totalRevenue / (totalLoadedMiles + totalDeadheadMiles + totalReturnHomeMiles)." },
          loadedRatio:        { type: "number", description: "loaded / total miles, as a decimal between 0 and 1." },
          narrative:          { type: "string", description: "2-4 sentence summary of the week's economics — what worked, what cost margin, etc." },
        },
        required: ["totalRevenue", "totalLoadedMiles", "totalDeadheadMiles", "totalReturnHomeMiles", "fleetTrueRpm", "loadedRatio", "narrative"],
      },
    },
    required: ["loads", "unmatchedMovements", "summary"],
  },
};

costAnalysis.get("/", requireCapability("loads.view"), async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const vehicleIdStr = url.searchParams.get("vehicleId");
  const from = url.searchParams.get("from"); // ISO
  const to   = url.searchParams.get("to");   // ISO
  if (!vehicleIdStr || !from || !to) {
    return c.json({ error: "vehicleId, from, to required" }, 400);
  }
  const vehicleId = Number(vehicleIdStr);

  // Resolve asset from the Motive vehicle id (joins are via text column in assets).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: asset, error: assetErr } = await (supabase as any)
    .from("assets")
    .select("id, name, unit, motive_vehicle_id")
    .eq("org_id", orgId)
    .eq("motive_vehicle_id", String(vehicleId))
    .maybeSingle();
  if (assetErr) {
    console.error("[cost-analysis] asset lookup:", assetErr);
    return c.json({ error: "asset_lookup_failed", detail: assetErr.message }, 500);
  }
  if (!asset) {
    return c.json({ error: "no_asset_linked", detail: `No asset linked to Motive vehicle ${vehicleId}` }, 404);
  }

  // Pull movements (raw driving periods, not clustered — Claude can
  // see the fragmentation itself; clustering would hide signal).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: movements, error: mErr } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id, start_time, end_time, miles, duration, origin, destination, vehicle_number")
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleId)
    .gte("start_time", from)
    .lt("start_time", to)
    .order("start_time", { ascending: true });
  if (mErr) {
    console.error("[cost-analysis] movements:", mErr);
    return c.json({ error: "movements_fetch_failed", detail: mErr.message }, 500);
  }

  // Pull loads (events) for that asset in the same window. Pull the
  // load info (price, broker, miles quoted) via the FK to loads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: events, error: eErr } = await (supabase as any)
    .from("events")
    .select(`
      id, title, start, "end", loaded_miles, status,
      load:loads(id, broker, load_price, load_num, commodity)
    `)
    .eq("org_id", orgId)
    .eq("asset_id", asset.id)
    .gte("start", from)
    .lt("start", to)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (eErr) {
    console.error("[cost-analysis] events:", eErr);
    return c.json({ error: "events_fetch_failed", detail: eErr.message }, 500);
  }

  // Pull stops for those events.
  const eventIds = (events ?? []).map((e: { id: string }) => e.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stops } = eventIds.length > 0
    ? await (supabase as any)
        .from("stops")
        .select("event_id, sequence, type, facility_name, address, city, state, appt_start, appt_end")
        .in("event_id", eventIds)
        .order("sequence", { ascending: true })
    : { data: [] };

  // Build the user-message payload as a structured text block.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stopsByEvent = new Map<string, any[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const s of (stops ?? []) as any[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(s);
    stopsByEvent.set(s.event_id, arr);
  }

  const movementsBlock = (movements ?? []).length === 0
    ? "(no movements in window)"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : (movements as any[]).map((m) => {
        const miles = m.miles != null ? `${m.miles.toFixed(1)} mi` : "?? mi";
        const dur   = m.duration != null ? `${Math.round(m.duration / 60)} min` : "?? min";
        return `M${m.id}: ${m.start_time} → ${m.end_time ?? "??"} | ${m.origin ?? "??"} → ${m.destination ?? "??"} | ${miles} | ${dur}`;
      }).join("\n");

  const loadsBlock = (events ?? []).length === 0
    ? "(no loads in window)"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : (events as any[]).map((e) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const evStops = (stopsByEvent.get(e.id) ?? []) as any[];
        const stopsText = evStops.length === 0
          ? "  (no stops on record)"
          : evStops.map(s =>
              `  ${s.sequence}. ${s.type ?? "stop"} — ${s.facility_name ?? ""} ${s.address ?? ""} ${s.city ?? ""} ${s.state ?? ""}` +
              (s.appt_start ? ` (appt ${s.appt_start}${s.appt_end ? "→" + s.appt_end : ""})` : "")
            ).join("\n");
        const load = e.load as { broker?: string; load_price?: number; load_num?: string; commodity?: string } | null;
        return [
          `L${e.id}: ${e.title ?? "(no title)"}`,
          `  Status: ${e.status ?? "??"}  |  Window: ${e.start} → ${e.end}`,
          `  Loaded miles (quoted): ${e.loaded_miles ?? "??"}  |  Revenue: $${load?.load_price ?? "??"}  |  Broker: ${load?.broker ?? "??"}  |  Load #: ${load?.load_num ?? "??"}  |  Commodity: ${load?.commodity ?? "??"}`,
          stopsText,
        ].join("\n");
      }).join("\n\n");

  const userMessage = [
    `# Asset`,
    `${asset.name}${asset.unit ? ` (#${asset.unit})` : ""}  —  Motive vehicle ${vehicleId}`,
    ``,
    `# Window`,
    `${from} → ${to}`,
    ``,
    `# Scheduled loads`,
    loadsBlock,
    ``,
    `# Telemetry movements`,
    movementsBlock,
    ``,
    `Now produce the analysis by calling submit_analysis.`,
  ].join("\n");

  let response;
  try {
    response = await client.messages.create({
      model:      MODEL,
      max_tokens: 8000,
      system:     [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools:      [ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: "submit_analysis" },
      messages:   [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    console.error("[cost-analysis] anthropic call failed:", err);
    return c.json({ error: "ai_failed", detail: (err as Error).message }, 500);
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return c.json({ error: "no_tool_use", detail: "Model didn't call the submit_analysis tool." }, 500);
  }

  return c.json({
    vehicleId,
    window: { from, to },
    counts: {
      movements: (movements ?? []).length,
      loads:     (events ?? []).length,
    },
    analysis: toolUse.input,
    usage: {
      inputTokens:        response.usage?.input_tokens,
      outputTokens:       response.usage?.output_tokens,
      cacheCreationTokens: response.usage?.cache_creation_input_tokens,
      cacheReadTokens:     response.usage?.cache_read_input_tokens,
    },
  });
});

export default costAnalysis;
