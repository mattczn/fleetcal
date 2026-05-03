/**
 * /v1/assistant — dispatcher chat assistant.
 *
 * The client sends just chat messages. The server pulls the org's loads
 * (with stops), assets, drivers, customers, trailers, dispatchers, and
 * driver-asset prefs from the DB and builds an expanded system prompt
 * for Claude. Streams the response back as plain text.
 *
 * Window: defaults to today-7d / today+14d. Caller can pass `from`/`to`
 * (ISO strings) in the body to override.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import Anthropic from "@anthropic-ai/sdk";

import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";
import type { AuthVariables } from "../middleware/clerk.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

const assistant = new Hono<{ Variables: AuthVariables }>();

interface AssistantBody {
  messages: { role: "user" | "assistant"; content: string }[];
  from?: string;
  to?: string;
}

interface AssetRow { id: number; name: string; unit: string | null; type: string; hidden: boolean; }
interface DriverRow { id: number; name: string; phone: string | null; }
interface CustomerRow { id: string; name: string; aliases: string[] | null; short_name: string | null; mc_num: string | null; }
interface TrailerRow { id: number; name: string; trailer_number: string | null; category: string; }
interface DispatcherRow { id: string; name: string; is_default: boolean; }
interface PrefRow { asset_id: number; driver_id: number; }

interface LoadRow {
  id: string;
  load_num: string | null;
  internal_load_id: number;
  broker: string | null;
  load_price: number | null;
  notes: string | null;          // load-level
  accessorials: unknown;          // jsonb
  customer_id: string | null;
  ref_nums: string | null;
}
interface EventRow {
  id: string;
  load_id: string | null;
  asset_id: number;
  driver_id: number | null;
  driver_name: string | null;
  title: string;
  start: string;
  end: string;
  status: string;
  relay_role: string | null;
  trailer_id: number | null;
  trailer_type: string | null;
  driver_pay: number | null;
  notes: string | null;          // event-level
  event_kind: string | null;
  non_revenue_type: string | null;
}
interface StopRow {
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  city: string | null;
  appt_start: string | null;
  appt_end: string | null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "?";
  // events.start is naive "YYYY-MM-DDTHH:mm" already
  return iso.replace("T", " ").slice(0, 16);
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function buildContext(args: {
  events: EventRow[];
  loads: Map<string, LoadRow>;
  stopsByEvent: Map<string, StopRow[]>;
  assets: AssetRow[];
  drivers: DriverRow[];
  customers: CustomerRow[];
  trailers: TrailerRow[];
  dispatchers: DispatcherRow[];
  prefs: PrefRow[];
  fromIso: string;
  toIso: string;
}): string {
  const { events, loads, stopsByEvent, assets, drivers, customers, trailers, dispatchers, prefs, fromIso, toIso } = args;

  const assetById = new Map<number, AssetRow>(assets.map((a) => [a.id, a]));
  const driverById = new Map<number, DriverRow>(drivers.map((d) => [d.id, d]));
  const trailerById = new Map<number, TrailerRow>(trailers.map((t) => [t.id, t]));
  const customerById = new Map<string, CustomerRow>(customers.map((c) => [c.id, c]));

  // Group events by load_id so relay legs read together.
  const eventsByLoad = new Map<string, EventRow[]>();
  const nonRevenue: EventRow[] = [];
  for (const ev of events) {
    if (ev.load_id) {
      const arr = eventsByLoad.get(ev.load_id) ?? [];
      arr.push(ev);
      eventsByLoad.set(ev.load_id, arr);
    } else {
      nonRevenue.push(ev);
    }
  }

  // Build LOADS section
  const loadEntries: string[] = [];
  for (const [loadId, legs] of eventsByLoad) {
    const load = loads.get(loadId);
    if (!load) continue;
    legs.sort((a, b) => a.start.localeCompare(b.start));

    const lines: string[] = [];
    const head = `Load #${load.internal_load_id}${load.load_num ? ` (broker #${load.load_num})` : ""}`;
    lines.push(head);
    if (load.broker) {
      const cust = load.customer_id ? customerById.get(load.customer_id) : null;
      const aliasNote = cust?.aliases?.length ? ` [aliases: ${cust.aliases.join(", ")}]` : "";
      lines.push(`  Broker: ${load.broker}${aliasNote}`);
    }
    if (load.load_price != null) lines.push(`  Rate: ${fmtMoney(load.load_price)}`);
    if (load.notes) lines.push(`  Load notes: ${load.notes.slice(0, 200)}`);

    const accs = Array.isArray(load.accessorials) ? load.accessorials : [];
    if (accs.length > 0) {
      const accLine = (accs as Array<{ category?: string; description?: string; amount?: number; status?: string }>)
        .map((a) => `${a.category ?? "?"}${a.description ? ` (${a.description})` : ""}${a.amount != null ? ` ${fmtMoney(a.amount)}` : ""}${a.status ? ` [${a.status}]` : ""}`)
        .join("; ");
      lines.push(`  Accessorials: ${accLine}`);
    }
    if (load.ref_nums) {
      try {
        const arr = JSON.parse(load.ref_nums);
        if (Array.isArray(arr) && arr.length) {
          const formatted = arr.map((r: unknown) => typeof r === "object" && r ? `${(r as { label?: string }).label ?? ""}=${(r as { value?: string }).value ?? ""}` : String(r)).join(", ");
          lines.push(`  Refs: ${formatted}`);
        }
      } catch { /* ignore */ }
    }

    for (const ev of legs) {
      const asset = assetById.get(ev.asset_id);
      const driver = ev.driver_id ? driverById.get(ev.driver_id) : null;
      const trailer = ev.trailer_id ? trailerById.get(ev.trailer_id) : null;
      const legLabel = ev.relay_role ? ` [${ev.relay_role.toUpperCase()} LEG]` : "";

      lines.push(`  Leg${legLabel}: ${fmtDate(ev.start)} → ${fmtDate(ev.end)} · status=${ev.status}`);
      if (asset) lines.push(`    Truck: ${asset.name}${asset.unit ? ` #${asset.unit}` : ""}`);
      if (driver) lines.push(`    Driver: ${driver.name}${driver.phone ? ` (${driver.phone})` : ""}`);
      else if (ev.driver_name) lines.push(`    Driver: ${ev.driver_name}`);
      if (trailer) lines.push(`    Trailer: ${trailer.name}${trailer.trailer_number ? ` #${trailer.trailer_number}` : ""} (${trailer.category})`);
      else if (ev.trailer_type) lines.push(`    Trailer type: ${ev.trailer_type}`);
      if (ev.driver_pay != null) lines.push(`    Driver pay: ${fmtMoney(ev.driver_pay)}`);
      if (ev.notes) lines.push(`    Leg notes: ${ev.notes.slice(0, 200)}`);

      const stops = stopsByEvent.get(ev.id) ?? [];
      if (stops.length > 0) {
        const stopLines = stops
          .sort((a, b) => a.sequence - b.sequence)
          .map((s) => {
            const where = [s.facility_name, s.city].filter(Boolean).join(", ") || "?";
            const when = s.appt_start ? ` @ ${fmtDate(s.appt_start)}${s.appt_end && s.appt_end !== s.appt_start ? `–${fmtDate(s.appt_end).slice(11)}` : ""}` : "";
            return `      ${s.sequence}. ${s.type}: ${where}${when}`;
          });
        lines.push(`    Stops:`);
        lines.push(...stopLines);
      }
    }
    loadEntries.push(lines.join("\n"));
  }

  // Non-revenue events (maintenance, deadhead, etc.)
  const nonRevLines: string[] = [];
  for (const ev of nonRevenue) {
    const asset = assetById.get(ev.asset_id);
    const driver = ev.driver_id ? driverById.get(ev.driver_id) : null;
    const kind = ev.non_revenue_type ?? ev.event_kind ?? "non-revenue";
    nonRevLines.push(
      `${kind}: ${ev.title} · ${fmtDate(ev.start)} → ${fmtDate(ev.end)} · ${asset?.name ?? "?"}${driver ? ` · ${driver.name}` : ""}`
    );
  }

  // Reference data sections
  const truckLines = assets.filter((a) => !a.hidden).map((a) =>
    `- ${a.name}${a.unit ? ` #${a.unit}` : ""} (${a.type})`,
  );
  const driverLines = drivers.map((d) => `- ${d.name}${d.phone ? ` (${d.phone})` : ""}`);
  const customerLines = customers.map((c) => {
    const parts = [c.name];
    if (c.short_name) parts.push(`short: ${c.short_name}`);
    if (c.mc_num) parts.push(`MC: ${c.mc_num}`);
    if (c.aliases?.length) parts.push(`aliases: ${c.aliases.join(", ")}`);
    return `- ${parts.join(" · ")}`;
  });
  const trailerLines = trailers.map((t) => `- ${t.name}${t.trailer_number ? ` #${t.trailer_number}` : ""} (${t.category})`);
  const dispatcherLines = dispatchers.map((d) => `- ${d.name}${d.is_default ? " (default)" : ""}`);

  // Driver-asset prefs: "Truck X is usually driven by Driver Y"
  const prefLines: string[] = [];
  for (const p of prefs) {
    const truck = assetById.get(p.asset_id);
    const driver = driverById.get(p.driver_id);
    if (truck && driver) prefLines.push(`- ${truck.name}${truck.unit ? ` #${truck.unit}` : ""} → ${driver.name}`);
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const nowStr = now.toISOString().slice(0, 16).replace("T", " ");

  return `You are a dispatch assistant for a trucking company. Answer questions about loads, drivers, and trucks using the data below. Be concise and direct. Format numbers with $ or commas where appropriate. When the user asks about "today" / "this week" / "tomorrow", use the date below as the reference point.

CURRENT TIME: ${nowStr} (UTC reference)
TODAY'S DATE: ${todayStr}
DATA WINDOW: ${fromIso.slice(0, 10)} to ${toIso.slice(0, 10)}

TRUCKS (${truckLines.length}):
${truckLines.join("\n") || "None"}

DRIVERS (${driverLines.length}):
${driverLines.join("\n") || "None"}

PREFERRED DRIVER PER TRUCK:
${prefLines.join("\n") || "None set"}

TRAILERS (${trailerLines.length}):
${trailerLines.join("\n") || "None"}

CUSTOMERS / BROKERS (${customerLines.length}):
${customerLines.join("\n") || "None"}

DISPATCHERS:
${dispatcherLines.join("\n") || "None"}

LOADS (${eventsByLoad.size} loads, ${events.length} legs in window):
${loadEntries.join("\n\n") || "None in window"}

${nonRevLines.length ? `NON-REVENUE EVENTS:\n${nonRevLines.join("\n")}` : ""}`;
}

assistant.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<AssistantBody>().catch(() => null);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "validation_failed", errors: ["messages array required"] }, 400);
  }

  // Default window: today-7d to today+14d. Smaller than the calendar's
  // 28-day load to keep the prompt focused on what dispatchers usually
  // ask about.
  const now = new Date();
  const fromDefault = new Date(now); fromDefault.setDate(now.getDate() - 7);
  const toDefault   = new Date(now); toDefault.setDate(now.getDate() + 14);
  const fromIso = body.from ?? fromDefault.toISOString();
  const toIso   = body.to   ?? toDefault.toISOString();

  // Fire all queries in parallel.
  const [eventsRes, loadsRes, assetsRes, driversRes, customersRes, trailersRes, dispatchersRes, prefsRes] = await Promise.all([
    supabase.from("events")
      .select("id,load_id,asset_id,driver_id,driver_name,title,start,end,status,relay_role,trailer_id,trailer_type,driver_pay,notes,event_kind,non_revenue_type")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .gte("end", fromIso)
      .lte("start", toIso)
      .order("start", { ascending: true }),
    supabase.from("loads")
      .select("id,load_num,internal_load_id,broker,load_price,notes,accessorials,customer_id,ref_nums")
      .eq("org_id", orgId)
      .is("deleted_at", null),
    supabase.from("assets")
      .select("id,name,unit,type,hidden")
      .eq("org_id", orgId),
    supabase.from("drivers")
      .select("id,name,phone")
      .eq("org_id", orgId)
      .order("name", { ascending: true }),
    supabase.from("customers")
      .select("id,name,aliases,short_name,mc_num")
      .eq("org_id", orgId)
      .order("name", { ascending: true }),
    supabase.from("trailers")
      .select("id,name,trailer_number,category")
      .eq("org_id", orgId)
      .order("name", { ascending: true }),
    supabase.from("dispatchers")
      .select("id,name,is_default")
      .eq("org_id", orgId)
      .order("name", { ascending: true }),
    supabase.from("driver_asset_prefs")
      .select("asset_id,driver_id")
      .eq("org_id", orgId),
  ]);

  if (eventsRes.error || loadsRes.error || assetsRes.error || driversRes.error) {
    console.error("[POST /v1/assistant] DB fetch failed:", {
      events: eventsRes.error, loads: loadsRes.error, assets: assetsRes.error, drivers: driversRes.error,
    });
    return c.json({ error: "fetch_failed" }, 500);
  }

  const events = (eventsRes.data ?? []) as EventRow[];
  const loadsArr = (loadsRes.data ?? []) as LoadRow[];
  const loads = new Map(loadsArr.map((l) => [l.id, l]));

  // Stops for the events in scope
  const stopsByEvent = new Map<string, StopRow[]>();
  if (events.length > 0) {
    const eventIds = events.map((e) => e.id);
    const { data: stopRows } = await supabase
      .from("stops")
      .select("event_id,sequence,type,facility_name,city,appt_start,appt_end")
      .in("event_id", eventIds);
    for (const s of (stopRows ?? []) as StopRow[]) {
      const arr = stopsByEvent.get(s.event_id) ?? [];
      arr.push(s);
      stopsByEvent.set(s.event_id, arr);
    }
  }

  const systemPrompt = buildContext({
    events,
    loads,
    stopsByEvent,
    assets:      (assetsRes.data ?? [])      as AssetRow[],
    drivers:     (driversRes.data ?? [])     as DriverRow[],
    customers:   (customersRes.data ?? [])   as CustomerRow[],
    trailers:    (trailersRes.data ?? [])    as TrailerRow[],
    dispatchers: (dispatchersRes.data ?? []) as DispatcherRow[],
    prefs:       (prefsRes.data ?? [])       as PrefRow[],
    fromIso,
    toIso,
  });

  const claudeStream = await client.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: body.messages,
  });

  return stream(c, async (s) => {
    s.onAbort(() => { /* client disconnected; iterator cleanup is automatic */ });
    for await (const chunk of claudeStream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        await s.write(chunk.delta.text);
      }
    }
  });
});

export default assistant;
