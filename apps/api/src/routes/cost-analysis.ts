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
// Opus is the right tool for this — multi-step geographic + temporal
// matching across telemetry and load schedules, then dollar math.
// Quality matters more than latency since the result is persisted.
const MODEL  = "claude-opus-4-5";

const costAnalysis = new Hono<{ Variables: AuthVariables }>();

const SYSTEM_PROMPT = `You are analyzing a trucking dispatcher's data to figure out the *true* economics per load.

Two data streams will be provided for one truck over a date range:

1. SCHEDULED LOADS — what dispatch booked: load id, customer, pickup/delivery stops with addresses + appointment times, load price (revenue), loaded-mile estimate, and driver pay (what we paid the driver for this load).

2. TELEMETRY MOVEMENTS — what the truck actually did: each driving period from the ELD with start/end timestamp, origin + destination text, miles driven, duration in seconds.

Your job is to match movements to loads, account for the empty miles + time around each load, and report a full per-load economic picture. Definitions:

MILEAGE BUCKETS:
- **Loaded miles**: movement miles between pickup and delivery for a load. Match by time + geography.
- **Deadhead before**: positioning miles to reach pickup (from prior drop, yard, or home).
- **Deadhead after**: miles after delivery toward the next load's pickup OR back to home if no next load.
- **Return home**: a special deadhead-after case where the truck returns to base (typically the last movement of the window).

TIME BUCKETS (mirror the mileage buckets, in HOURS):
- **Loaded hours**: sum of duration of matched-to-load movements / 3600.
- **Deadhead hours before**: positioning duration before pickup.
- **Deadhead hours after**: duration after delivery toward next load or home.
- Track hours separately from miles — a slow-moving 30 mi inner-city run can take longer than a 70 mi highway run, and that time has cost (driver wages, opportunity cost).

REVENUE / COST:
- **Revenue**: load_price from the rate-con.
- **Driver pay**: amount paid to the driver for this load (the dispatcher's actual payout — already known per load).
- **Margin after driver**: revenue − driver_pay. This is gross-margin before fuel/maintenance/insurance.

METRICS (all to two decimals):
- **Stated RPM** = revenue / loaded_miles. What the rate-con looks like in isolation.
- **True RPM**   = revenue / (loaded_miles + deadhead_before + deadhead_after). What dispatch is actually earning per turn of the wheel.
- **Stated RPH** = revenue / loaded_hours. Hourly rate on paper.
- **True RPH**   = revenue / (loaded_hours + deadhead_hours_before + deadhead_hours_after). Real hourly rate, including time spent positioning.
- **Margin RPM** = (revenue − driver_pay) / (loaded_miles + deadhead). Margin to the business per actual mile after driver cost.
- **Margin RPH** = (revenue − driver_pay) / total_hours. Margin per hour.

RULES:
- Be conservative. Mark confidence "low" when time/geography evidence is weak.
- Account for *every* movement — either it belongs to a load, or it's labeled in unmatchedMovements as positioning, return_home, personal, or unknown.
- Avoid double-counting miles or time. A movement belongs to at most one bucket.
- Output ONLY via the submit_analysis tool. Don't write prose outside the tool.

When you reason, look for:
- Movement times falling between a load's pickup and delivery appointments
- Movement origin/destination cities matching the load's pickup/delivery cities
- Gaps between loads where the truck moved → positioning
- The last movement of the window with no follow-on load → likely return-home

The interesting tells are loads where stated RPM looks good but true RPH crashes because the positioning took half a day, or loads where margin-after-driver is negative because deadhead miles ate the whole price.
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
            deadheadMilesAfter:   { type: "number", description: "Miles after delivery toward the next load's pickup OR home." },

            loadedHours:          { type: "number", description: "Hours under load (matched movement durations summed)." },
            deadheadHoursBefore:  { type: "number", description: "Hours of positioning before pickup." },
            deadheadHoursAfter:   { type: "number", description: "Hours after delivery toward next or home." },

            revenue:              { type: "number", description: "Load price in dollars." },
            driverPay:            { type: "number", description: "Amount paid to the driver for this load (from input). 0 if unknown." },
            marginAfterDriver:    { type: "number", description: "revenue − driverPay." },

            statedRpm:            { type: "number", description: "revenue / loadedMiles." },
            trueRpm:              { type: "number", description: "revenue / (loadedMiles + deadheadMilesBefore + deadheadMilesAfter)." },
            statedRph:            { type: "number", description: "revenue / loadedHours." },
            trueRph:              { type: "number", description: "revenue / (loadedHours + deadheadHoursBefore + deadheadHoursAfter)." },
            marginRpm:            { type: "number", description: "marginAfterDriver / (loadedMiles + deadheadMilesBefore + deadheadMilesAfter)." },
            marginRph:            { type: "number", description: "marginAfterDriver / (loadedHours + deadheadHoursBefore + deadheadHoursAfter)." },

            reasoning:            { type: "string", description: "Plain-English one-paragraph explanation of how you matched and where the deadhead came from. Call out time costs explicitly when significant." },
          },
          required: [
            "loadId", "loadLabel", "confidence", "matchedMovementIds",
            "loadedMiles", "deadheadMilesBefore", "deadheadMilesAfter",
            "loadedHours", "deadheadHoursBefore", "deadheadHoursAfter",
            "revenue", "driverPay", "marginAfterDriver",
            "statedRpm", "trueRpm", "statedRph", "trueRph", "marginRpm", "marginRph",
            "reasoning",
          ],
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
          totalRevenue:         { type: "number" },
          totalDriverPay:       { type: "number" },
          totalMargin:          { type: "number", description: "totalRevenue − totalDriverPay." },
          totalLoadedMiles:     { type: "number" },
          totalDeadheadMiles:   { type: "number" },
          totalReturnHomeMiles: { type: "number" },
          totalLoadedHours:     { type: "number" },
          totalDeadheadHours:   { type: "number" },
          fleetTrueRpm:         { type: "number", description: "totalRevenue / (totalLoadedMiles + totalDeadheadMiles + totalReturnHomeMiles)." },
          fleetTrueRph:         { type: "number", description: "totalRevenue / (totalLoadedHours + totalDeadheadHours)." },
          fleetMarginRpm:       { type: "number", description: "totalMargin / total miles." },
          fleetMarginRph:       { type: "number", description: "totalMargin / total hours." },
          loadedRatio:          { type: "number", description: "loaded miles / total miles, decimal 0-1." },
          narrative:            { type: "string", description: "2-4 sentences — week's economics, what worked, where time/deadhead/driver pay ate margin, which loads were actually profitable." },
        },
        required: [
          "totalRevenue", "totalDriverPay", "totalMargin",
          "totalLoadedMiles", "totalDeadheadMiles", "totalReturnHomeMiles",
          "totalLoadedHours", "totalDeadheadHours",
          "fleetTrueRpm", "fleetTrueRph", "fleetMarginRpm", "fleetMarginRph",
          "loadedRatio", "narrative",
        ],
      },
    },
    required: ["loads", "unmatchedMovements", "summary"],
  },
};

// ── Latest saved report ────────────────────────────────────────────────
// Loaded on Cost-tab open so dispatchers see the most recent analysis
// without spending tokens. Returns 404 when there's no prior run.

costAnalysis.get("/latest", requireCapability("loads.view"), async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const vehicleIdStr = url.searchParams.get("vehicleId");
  if (!vehicleIdStr) return c.json({ error: "vehicleId required" }, 400);
  const vehicleId = Number(vehicleIdStr);
  if (!Number.isFinite(vehicleId)) return c.json({ error: "vehicleId must be numeric" }, 400);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("cost_analysis_reports")
    .select("id, window_from, window_to, result, counts, usage, model, created_at, created_by")
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[cost-analysis] latest fetch:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  if (!data) return c.json({ report: null });
  return c.json({ report: data });
});

// ── Run + persist ──────────────────────────────────────────────────────
// Generates a fresh analysis from Claude and stores it. The new row
// becomes the "latest" on the next /latest call.

costAnalysis.post("/run", requireCapability("loads.view"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try { body = await c.req.json(); } catch { /* allow empty */ }

  const vehicleIdStr = body?.vehicleId != null ? String(body.vehicleId) : null;
  const from = typeof body?.from === "string" ? body.from : null;
  const to   = typeof body?.to   === "string" ? body.to   : null;
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
      id, title, start, "end", loaded_miles, status, driver_pay, driver_name,
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
          `  Loaded miles (quoted): ${e.loaded_miles ?? "??"}  |  Revenue: $${load?.load_price ?? "??"}  |  Driver pay: $${e.driver_pay ?? "??"}  |  Driver: ${e.driver_name ?? "??"}`,
          `  Broker: ${load?.broker ?? "??"}  |  Load #: ${load?.load_num ?? "??"}  |  Commodity: ${load?.commodity ?? "??"}`,
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

  const counts = {
    movements: (movements ?? []).length,
    loads:     (events ?? []).length,
  };
  const usage = {
    inputTokens:        response.usage?.input_tokens ?? null,
    outputTokens:       response.usage?.output_tokens ?? null,
    cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
    cacheReadTokens:     response.usage?.cache_read_input_tokens ?? null,
  };

  // Persist before returning. We don't block the response on insert
  // failure — the user still gets the freshly-generated analysis, but
  // it just won't be cached for the next /latest call. Logged for
  // follow-up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: saved, error: insertErr } = await (supabase as any)
    .from("cost_analysis_reports")
    .insert({
      org_id:      orgId,
      vehicle_id:  vehicleId,
      asset_id:    asset.id,
      window_from: from,
      window_to:   to,
      result:      toolUse.input,
      counts,
      usage,
      model:       MODEL,
      created_by:  userId ?? null,
    })
    .select("id, created_at")
    .maybeSingle();
  if (insertErr) {
    console.error("[cost-analysis] insert failed (returning unsaved result):", insertErr);
  }

  return c.json({
    id:           saved?.id ?? null,
    createdAt:    saved?.created_at ?? null,
    vehicleId,
    window:       { from, to },
    counts,
    analysis:     toolUse.input,
    usage,
  });
});

// ── List loads in window (cheap, no AI) ────────────────────────────────
// Frontend uses this to learn what loads to chunk against. Returns just
// enough metadata to drive the per-load chunked flow.

costAnalysis.get("/loads-in-window", requireCapability("loads.view"), async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const vehicleIdStr = url.searchParams.get("vehicleId");
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");
  if (!vehicleIdStr || !from || !to) {
    return c.json({ error: "vehicleId, from, to required" }, 400);
  }
  const vehicleId = Number(vehicleIdStr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: asset, error: aErr } = await (supabase as any)
    .from("assets")
    .select("id")
    .eq("org_id", orgId)
    .eq("motive_vehicle_id", String(vehicleId))
    .maybeSingle();
  if (aErr) return c.json({ error: "asset_lookup_failed", detail: aErr.message }, 500);
  if (!asset) return c.json({ events: [], assetId: null });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: events, error: eErr } = await (supabase as any)
    .from("events")
    .select("id, title, start, \"end\"")
    .eq("org_id", orgId)
    .eq("asset_id", asset.id)
    .gte("start", from)
    .lt("start", to)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (eErr) return c.json({ error: "events_fetch_failed", detail: eErr.message }, 500);

  // Also count movements in the window so the UI can show what the
  // analysis will cover.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: movementsCount } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleId)
    .gte("start_time", from)
    .lt("start_time", to);

  return c.json({
    assetId: asset.id,
    events:  events ?? [],
    movementsCount: movementsCount ?? 0,
  });
});

// ─── Per-load chunked endpoints ───────────────────────────────────────
//
// The monolithic /run call was hitting 2+ minutes per analysis and
// dropping connections. Chunking breaks it into N parallel single-load
// calls (~15-30s each), which the frontend fires in parallel and
// renders progressively as each completes. After all loads finish, the
// frontend assembles them and calls /save to persist the bundle.

const SYSTEM_PROMPT_LOAD = `You are analyzing ONE truck load for a dispatch system.

You will receive:
1. ONE SCHEDULED LOAD with its stops, price, driver pay, and time window.
2. A SET OF MOVEMENTS that happened within roughly ±6 hours of that load. Some are this load's actual loaded miles, some are deadhead positioning before, some are deadhead after (toward the next load or home), some may be unrelated.

Your job: figure out which movements belong to which bucket FOR THIS LOAD and report the economic picture.

Definitions:
- **Loaded miles/hours**: movement under this specific load (between its pickup and delivery). Match by city + time window overlap.
- **Deadhead before**: positioning miles/hours to reach this load's pickup point.
- **Deadhead after**: miles/hours after this delivery, toward where the truck went next.

Metrics (two decimal places):
- statedRpm = revenue / loadedMiles
- trueRpm   = revenue / (loadedMiles + deadheadMilesBefore + deadheadMilesAfter)
- statedRph = revenue / loadedHours
- trueRph   = revenue / (loadedHours + deadheadHoursBefore + deadheadHoursAfter)
- marginAfterDriver = revenue − driverPay
- marginRpm = marginAfterDriver / total miles
- marginRph = marginAfterDriver / total hours

Rules:
- Be conservative. Use "low" confidence when geographic or time evidence is weak.
- A movement matches THIS load only if its start_time falls inside the load's appointment window AND its cities align with the load's pickup/delivery cities.
- Don't claim movements that clearly belong to a different time window — those are just context.
- Output ONLY via submit_load_analysis. No prose outside the tool.
`;

const ANALYSIS_LOAD_TOOL: Anthropic.Tool = {
  name: "submit_load_analysis",
  description: "Submit the cost analysis for this single load.",
  input_schema: {
    type: "object",
    properties: {
      loadLabel:           { type: "string" },
      confidence:          { type: "string", enum: ["high", "medium", "low"] },
      matchedMovementIds:  { type: "array", items: { type: "number" } },
      loadedMiles:         { type: "number" },
      deadheadMilesBefore: { type: "number" },
      deadheadMilesAfter:  { type: "number" },
      loadedHours:         { type: "number" },
      deadheadHoursBefore: { type: "number" },
      deadheadHoursAfter:  { type: "number" },
      revenue:             { type: "number" },
      driverPay:           { type: "number" },
      marginAfterDriver:   { type: "number" },
      statedRpm:           { type: "number" },
      trueRpm:             { type: "number" },
      statedRph:           { type: "number" },
      trueRph:             { type: "number" },
      marginRpm:           { type: "number" },
      marginRph:           { type: "number" },
      reasoning:           { type: "string", description: "One paragraph: how you matched, where deadhead came from, any time costs worth flagging." },
    },
    required: [
      "loadLabel", "confidence", "matchedMovementIds",
      "loadedMiles", "deadheadMilesBefore", "deadheadMilesAfter",
      "loadedHours", "deadheadHoursBefore", "deadheadHoursAfter",
      "revenue", "driverPay", "marginAfterDriver",
      "statedRpm", "trueRpm", "statedRph", "trueRph", "marginRpm", "marginRph",
      "reasoning",
    ],
  },
};

const CONTEXT_HOURS = 6;

costAnalysis.post("/load", requireCapability("loads.view"), async (c) => {
  const orgId = c.get("orgId");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try { body = await c.req.json(); } catch { /* allow empty */ }

  const vehicleIdStr = body?.vehicleId != null ? String(body.vehicleId) : null;
  const loadEventId  = typeof body?.eventId === "string" ? body.eventId : null;
  if (!vehicleIdStr || !loadEventId) {
    return c.json({ error: "vehicleId and eventId required" }, 400);
  }
  const vehicleId = Number(vehicleIdStr);

  // Pull the single event + stops + load
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: event, error: eErr } = await (supabase as any)
    .from("events")
    .select(`
      id, title, start, "end", loaded_miles, status, driver_pay, driver_name, asset_id,
      load:loads(id, broker, load_price, load_num, commodity)
    `)
    .eq("id", loadEventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (eErr || !event) {
    return c.json({ error: "event_not_found", detail: eErr?.message }, 404);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stops } = await (supabase as any)
    .from("stops")
    .select("sequence, type, facility_name, address, city, state, appt_start, appt_end")
    .eq("event_id", loadEventId)
    .order("sequence", { ascending: true });

  // Movement context window: load.start − 6h to load.end + 6h
  const loadStartMs = new Date(event.start).getTime();
  const loadEndMs   = new Date(event.end).getTime();
  const ctxFromIso  = new Date(loadStartMs - CONTEXT_HOURS * 3_600_000).toISOString();
  const ctxToIso    = new Date(loadEndMs   + CONTEXT_HOURS * 3_600_000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: movements, error: mErr } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id, start_time, end_time, miles, duration, origin, destination")
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleId)
    .gte("start_time", ctxFromIso)
    .lt("start_time", ctxToIso)
    .order("start_time", { ascending: true });
  if (mErr) {
    return c.json({ error: "movements_fetch_failed", detail: mErr.message }, 500);
  }

  // Build a compact prompt for this single load
  const stopsText = (stops ?? []).length === 0
    ? "  (no stops on record)"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : (stops as any[]).map((s) =>
        `  ${s.sequence}. ${s.type ?? "stop"} — ${s.facility_name ?? ""} ${s.address ?? ""} ${s.city ?? ""} ${s.state ?? ""}` +
        (s.appt_start ? ` (appt ${s.appt_start}${s.appt_end ? "→" + s.appt_end : ""})` : "")
      ).join("\n");

  const load = event.load as { broker?: string; load_price?: number; load_num?: string; commodity?: string } | null;
  const loadBlock = [
    `LOAD ${event.id}: ${event.title ?? "(no title)"}`,
    `  Window: ${event.start} → ${event.end}`,
    `  Loaded miles (quoted): ${event.loaded_miles ?? "??"}  |  Revenue: $${load?.load_price ?? "??"}  |  Driver pay: $${event.driver_pay ?? "??"}`,
    `  Broker: ${load?.broker ?? "??"}  |  Load #: ${load?.load_num ?? "??"}  |  Commodity: ${load?.commodity ?? "??"}`,
    stopsText,
  ].join("\n");

  const movementsBlock = (movements ?? []).length === 0
    ? "(no movements in context window)"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : (movements as any[]).map((m) => {
        const miles = m.miles != null ? `${m.miles.toFixed(1)} mi` : "?? mi";
        const dur   = m.duration != null ? `${Math.round(m.duration / 60)} min` : "?? min";
        return `M${m.id}: ${m.start_time} → ${m.end_time ?? "??"} | ${m.origin ?? "??"} → ${m.destination ?? "??"} | ${miles} | ${dur}`;
      }).join("\n");

  const userMessage = [
    `# Load`,
    loadBlock,
    ``,
    `# Movements in the ±${CONTEXT_HOURS}h context window`,
    movementsBlock,
    ``,
    `Submit your analysis for THIS load via submit_load_analysis.`,
  ].join("\n");

  let response;
  try {
    response = await client.messages.create({
      model:      MODEL,
      max_tokens: 4000,
      system:     [{ type: "text", text: SYSTEM_PROMPT_LOAD, cache_control: { type: "ephemeral" } }],
      tools:      [ANALYSIS_LOAD_TOOL],
      tool_choice: { type: "tool", name: "submit_load_analysis" },
      messages:   [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    console.error("[cost-analysis/load] anthropic call failed:", err);
    return c.json({ error: "ai_failed", detail: (err as Error).message }, 500);
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return c.json({ error: "no_tool_use" }, 500);
  }

  return c.json({
    loadId: loadEventId,
    load:   toolUse.input,
    usage: {
      inputTokens:        response.usage?.input_tokens ?? null,
      outputTokens:       response.usage?.output_tokens ?? null,
      cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? null,
      cacheReadTokens:     response.usage?.cache_read_input_tokens ?? null,
    },
  });
});

// ── Save assembled bundle ──────────────────────────────────────────────
// Frontend calls this once all per-load chunks have come back. Body is
// the fully-assembled CostAnalysisResult shape so the saved row looks
// identical to anything /run produced.
costAnalysis.post("/save", requireCapability("loads.view"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try { body = await c.req.json(); } catch { /* allow empty */ }
  const { vehicleId, from, to, assetId, result, counts, usage } = body ?? {};
  if (!vehicleId || !from || !to || !result) {
    return c.json({ error: "vehicleId, from, to, result required" }, 400);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: saved, error } = await (supabase as any)
    .from("cost_analysis_reports")
    .insert({
      org_id:      orgId,
      vehicle_id:  Number(vehicleId),
      asset_id:    assetId ?? null,
      window_from: from,
      window_to:   to,
      result,
      counts:      counts ?? null,
      usage:       usage  ?? null,
      model:       MODEL,
      created_by:  userId ?? null,
    })
    .select("id, created_at")
    .maybeSingle();
  if (error) {
    console.error("[cost-analysis/save] insert failed:", error);
    return c.json({ error: "save_failed", detail: error.message }, 500);
  }
  return c.json({ id: saved?.id, createdAt: saved?.created_at });
});

export default costAnalysis;
