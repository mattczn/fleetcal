/**
 * /v1/assistant — dispatcher chat assistant.
 *
 * The client sends just chat messages. The server pulls the org's loads
 * (with stops), assets, drivers, customers, trailers, dispatchers, and
 * driver-asset prefs from the DB, builds an expanded system prompt, and
 * gives Claude a small toolbox so it can fetch specific data on demand
 * (search across the full dataset, full load details + audit log,
 * payroll summary for a driver). Streams text back to the client.
 *
 * Window: defaults to today-7d / today+14d. Caller can pass `from`/`to`
 * (ISO strings) in the body to override.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  TextBlock,
  ToolUseBlock,
  ContentBlock,
  Tool,
} from "@anthropic-ai/sdk/resources/messages.js";

import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";
import type { AuthVariables } from "../middleware/clerk.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_ITERATIONS = 5;

const assistant = new Hono<{ Variables: AuthVariables }>();

interface AssistantBody {
  messages: { role: "user" | "assistant"; content: string }[];
  /** IANA timezone name (e.g. "America/Denver"). Used so the agent knows
   *  the local "now" when interpreting "today" / "tonight" / "tomorrow". */
  timezone?: string;
  from?: string;
  to?: string;
}

interface AssetRow { id: number; name: string; unit: string | null; type: string; hidden: boolean; motive_vehicle_id: string | null; }
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
  notes: string | null;
  accessorials: unknown;
  customer_id: string | null;
  ref_nums: string | null;
  audit_log?: unknown;
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
  notes: string | null;
  event_kind: string | null;
  non_revenue_type: string | null;
}
interface StopRow {
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  city: string | null;
  address?: string | null;
  appt_start: string | null;
  appt_end: string | null;
  instructions?: string | null;
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "?";
  return iso.replace("T", " ").slice(0, 16);
}
function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
function fmtRelative(isoOrTimestamp: string): string {
  const ms = Date.now() - new Date(isoOrTimestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// ── Motive (ELD) locations ─────────────────────────────────────────────────
//
// Match the cache TTL the web app uses for the same endpoint (10 min).
// Stale entries are returned silently if the upstream call errors.

interface MotiveLocation { description: string; lat: number; lon: number; locatedAt: string; }

const motiveCache = new Map<string, { locations: Map<string, MotiveLocation>; fetchedAt: number }>();
const MOTIVE_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchMotiveLocations(orgId: string): Promise<Map<string, MotiveLocation>> {
  const cached = motiveCache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < MOTIVE_CACHE_TTL_MS) return cached.locations;

  const { data: settingsRow } = await supabase
    .from("org_settings")
    .select("motive_api_key")
    .eq("org_id", orgId)
    .maybeSingle();
  const apiKey = (settingsRow as { motive_api_key: string | null } | null)?.motive_api_key;
  if (!apiKey) {
    const empty = new Map<string, MotiveLocation>();
    motiveCache.set(orgId, { locations: empty, fetchedAt: Date.now() });
    return empty;
  }

  try {
    const res = await fetch("https://api.keeptruckin.com/v1/vehicle_locations?per_page=50", {
      headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`Motive ${res.status}`);
    const json = await res.json() as {
      vehicles?: Array<{ vehicle: { id: number; current_location: { description: string; lat: number; lon: number; located_at: string } | null } }>;
    };
    const map = new Map<string, MotiveLocation>();
    for (const v of json.vehicles ?? []) {
      const cl = v.vehicle.current_location;
      if (cl) map.set(String(v.vehicle.id), {
        description: cl.description, lat: cl.lat, lon: cl.lon, locatedAt: cl.located_at,
      });
    }
    motiveCache.set(orgId, { locations: map, fetchedAt: Date.now() });
    return map;
  } catch (err) {
    console.warn("[assistant] motive fetch failed:", err);
    return cached?.locations ?? new Map();
  }
}

// ── Static system context (everything that fits in one prompt) ────────────

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
  motiveLocations: Map<string, MotiveLocation>;
  fromIso: string;
  toIso: string;
  timezone: string;
}): string {
  const { events, loads, stopsByEvent, assets, drivers, customers, trailers, dispatchers, prefs, motiveLocations, fromIso, toIso, timezone } = args;

  const assetById = new Map<number, AssetRow>(assets.map((a) => [a.id, a]));
  const driverById = new Map<number, DriverRow>(drivers.map((d) => [d.id, d]));
  const trailerById = new Map<number, TrailerRow>(trailers.map((t) => [t.id, t]));
  const customerById = new Map<string, CustomerRow>(customers.map((c) => [c.id, c]));

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

  const loadEntries: string[] = [];
  for (const [loadId, legs] of eventsByLoad) {
    const load = loads.get(loadId);
    if (!load) continue;
    legs.sort((a, b) => a.start.localeCompare(b.start));

    const lines: string[] = [];
    lines.push(`Load #${load.internal_load_id}${load.load_num ? ` (broker #${load.load_num})` : ""}`);
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
        lines.push(`    Stops:`);
        for (const s of stops.sort((a, b) => a.sequence - b.sequence)) {
          const where = [s.facility_name, s.city].filter(Boolean).join(", ") || "?";
          const when = s.appt_start ? ` @ ${fmtDate(s.appt_start)}${s.appt_end && s.appt_end !== s.appt_start ? `–${fmtDate(s.appt_end).slice(11)}` : ""}` : "";
          lines.push(`      ${s.sequence}. ${s.type}: ${where}${when}`);
        }
      }
    }
    loadEntries.push(lines.join("\n"));
  }

  const nonRevLines = nonRevenue.map((ev) => {
    const asset = assetById.get(ev.asset_id);
    const driver = ev.driver_id ? driverById.get(ev.driver_id) : null;
    const kind = ev.non_revenue_type ?? ev.event_kind ?? "non-revenue";
    return `${kind}: ${ev.title} · ${fmtDate(ev.start)} → ${fmtDate(ev.end)} · ${asset?.name ?? "?"}${driver ? ` · ${driver.name}` : ""}`;
  });

  const truckLines = assets.filter((a) => !a.hidden).map((a) =>
    `- ${a.name}${a.unit ? ` #${a.unit}` : ""} (${a.type})`,
  );
  // Truck locations from Motive (only for assets with motive_vehicle_id wired up).
  const locationLines: string[] = [];
  for (const a of assets) {
    if (a.hidden || !a.motive_vehicle_id) continue;
    const loc = motiveLocations.get(a.motive_vehicle_id);
    if (!loc) continue;
    locationLines.push(`- ${a.name}${a.unit ? ` #${a.unit}` : ""}: ${loc.description} · ${fmtRelative(loc.locatedAt)}`);
  }
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

  const prefLines: string[] = [];
  for (const p of prefs) {
    const truck = assetById.get(p.asset_id);
    const driver = driverById.get(p.driver_id);
    if (truck && driver) prefLines.push(`- ${truck.name}${truck.unit ? ` #${truck.unit}` : ""} → ${driver.name}`);
  }

  // Local time per the user's calendar timezone setting. Critical so the
  // agent interprets "tonight" / "today" / "tomorrow" correctly.
  const now = new Date();
  const localFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const tzFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" });
  const tzAbbr = tzFmt.formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
  const localNow = localFmt.format(now);

  // YYYY-MM-DD date components in the local timezone (used for today/tomorrow strings).
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => dateParts.find((p) => p.type === t)?.value ?? "";
  const todayLocal = `${get("year")}-${get("month")}-${get("day")}`;
  const tomorrowLocal = (() => {
    const d = new Date(now); d.setDate(now.getDate() + 1);
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    return `${p.find(x => x.type === "year")?.value}-${p.find(x => x.type === "month")?.value}-${p.find(x => x.type === "day")?.value}`;
  })();

  return `You are a dispatch assistant for a trucking company. Answer questions about loads, drivers, and trucks using the data below. Be concise and direct. Format numbers with $ or commas where appropriate.

When the user says "today", "tonight", "tomorrow", "this week", etc., interpret those relative to the local time shown below — events.start/end strings in the data are in the same local timezone (no offset suffix). "Tonight" = the evening of TODAY (~17:00 onward through 23:59 local).

Tools available:
  Read:
  - search_loads: free-text search across ALL active loads (load #, broker, etc.)
  - get_load_details: full info for a single load (audit log, all stops, accessorials)
  - get_payroll_summary: a driver's adjustments + finalized pay records
  Write:
  - add_accessorial: append a detention/lumper/layover/scale_ticket/other charge to a load.

For WRITE tools: always restate exactly what you're about to do (which load, which amount, which category) and ask the user to confirm before calling. If their request is ambiguous (no specific load number or amount), ask first — never invent values.

LOCAL TIME: ${localNow} (${timezone}${tzAbbr ? `, ${tzAbbr}` : ""})
TODAY:    ${todayLocal}
TOMORROW: ${tomorrowLocal}
DATA WINDOW: ${fromIso.slice(0, 10)} to ${toIso.slice(0, 10)}

TRUCKS (${truckLines.length}):
${truckLines.join("\n") || "None"}

${locationLines.length ? `TRUCK LOCATIONS (Motive ELD, last seen):\n${locationLines.join("\n")}\n\n` : ""}DRIVERS (${driverLines.length}):
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

// ── Tool definitions (sent to Claude) ─────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "search_loads",
    description:
      "Search active loads (not soft-deleted) across the whole org by free text. " +
      "Matches load number, broker name, internal load id (if numeric), notes, and broker aliases. " +
      "Use when the user references a load that isn't in the data window above, or asks 'find loads where...'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search text — load number, broker, ref, etc." },
        limit: { type: "number", description: "Max results, default 20, max 50" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_load_details",
    description:
      "Fetch full detail for one load: every leg, every stop with addresses + appt times + instructions, " +
      "audit log history, accessorials with status, and ref numbers. " +
      "Identify the load by either its UUID or its 5+ digit internal load id.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string", description: "Load UUID or internal_load_id (numeric string)" },
      },
      required: ["loadId"],
    },
  },
  {
    name: "get_payroll_summary",
    description:
      "Fetch payroll info for a driver: adjustments (bonuses, deductions, deferrals) and finalized pay records. " +
      "Optionally filter to one week. Use when the user asks about pay status, deductions, bonuses, or week totals.",
    input_schema: {
      type: "object" as const,
      properties: {
        driverName: { type: "string", description: "Exact driver name (case sensitive)" },
        weekStart: { type: "string", description: "Optional YYYY-MM-DD; filters to one pay week" },
      },
      required: ["driverName"],
    },
  },
  {
    name: "add_accessorial",
    description:
      "Add an accessorial charge to a load (detention, lumper, layover, scale_ticket, or other). " +
      "Existing accessorials are preserved; the new one is appended. " +
      "BEFORE CALLING: confirm the load identifier and the dollar amount with the user — do not invent values. " +
      "Writes an audit log entry crediting 'AI Assistant'. Returns a summary of what was added.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId:      { type: "string", description: "Load UUID or internal_load_id (numeric, e.g. '10042')" },
        category:    { type: "string", enum: ["detention", "lumper", "layover", "scale_ticket", "other"] },
        amount:      { type: "number", description: "Dollar amount, positive number" },
        description: { type: "string", description: "Optional free-text description (e.g. '2 hr at receiver')" },
        billable:    { type: "boolean", description: "Billable to the broker. Default true." },
        status:      { type: "string", enum: ["requested", "approved", "denied"], description: "Optional approval status. Default 'requested'." },
        payToDriver: { type: "boolean", description: "If true, flows into driver payroll as an adjustment. Default false." },
      },
      required: ["loadId", "category", "amount"],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────

async function runSearchLoads(orgId: string, input: { query?: unknown; limit?: unknown }): Promise<string> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  if (query.length < 2) return "Query too short (min 2 chars).";

  const escaped = query.replace(/[%,()]/g, "\\$&");
  const pattern = `%${escaped}%`;
  const numericId = /^\d+$/.test(query) ? parseInt(query, 10) : null;
  const orFilter = numericId !== null
    ? `internal_load_id.eq.${numericId},load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`
    : `load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`;

  const { data, error } = await supabase
    .from("loads")
    .select("id,internal_load_id,load_num,broker,load_price,notes,customer_id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .or(orFilter)
    .limit(limit);
  if (error) return `Error: ${error.message}`;
  if (!data || data.length === 0) return "No loads matched.";

  // Pull leg start dates so the AI can sort/filter chronologically
  const ids = data.map((l) => l.id);
  const { data: legs } = await supabase
    .from("events")
    .select("load_id,start,driver_name,status")
    .in("load_id", ids)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start");
  const legsByLoad = new Map<string, Array<{ start: string; driver_name: string | null; status: string }>>();
  for (const l of (legs ?? []) as Array<{ load_id: string; start: string; driver_name: string | null; status: string }>) {
    const arr = legsByLoad.get(l.load_id) ?? [];
    arr.push({ start: l.start, driver_name: l.driver_name, status: l.status });
    legsByLoad.set(l.load_id, arr);
  }

  return data.map((l) => {
    const ll = legsByLoad.get(l.id) ?? [];
    const first = ll[0];
    const driver = first?.driver_name ?? "—";
    const status = first?.status ?? "—";
    const date = first?.start ? fmtDate(first.start).slice(0, 10) : "—";
    return `Load #${l.internal_load_id}${l.load_num ? ` (broker #${l.load_num})` : ""} · ${l.broker ?? "?"} · ${date} · ${driver} · ${status} · ${l.load_price != null ? fmtMoney(l.load_price) : "—"}`;
  }).join("\n");
}

async function runGetLoadDetails(orgId: string, input: { loadId?: unknown }): Promise<string> {
  const raw = typeof input.loadId === "string" ? input.loadId.trim() : "";
  if (!raw) return "loadId required.";

  let loadQuery = supabase
    .from("loads")
    .select("id,internal_load_id,load_num,broker,load_price,notes,accessorials,ref_nums,audit_log,customer_id,created_at")
    .eq("org_id", orgId);
  if (/^\d+$/.test(raw)) loadQuery = loadQuery.eq("internal_load_id", parseInt(raw, 10));
  else                    loadQuery = loadQuery.eq("id", raw);

  const { data: load, error } = await loadQuery.maybeSingle();
  if (error) return `Error: ${error.message}`;
  if (!load) return "Load not found.";

  const [{ data: events }, { data: customer }] = await Promise.all([
    supabase.from("events")
      .select("id,asset_id,driver_id,driver_name,title,start,end,status,relay_role,trailer_id,trailer_type,driver_pay,notes,deleted_at,audit_log")
      .eq("load_id", load.id)
      .eq("org_id", orgId)
      .order("start", { ascending: true }),
    load.customer_id
      ? supabase.from("customers").select("name,aliases,short_name,mc_num,contact_name,contact_phone,contact_email").eq("id", load.customer_id).eq("org_id", orgId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const eventList = (events ?? []) as Array<EventRow & { deleted_at: string | null; audit_log: unknown }>;
  const eventIds = eventList.map((e) => e.id);
  const { data: stops } = eventIds.length
    ? await supabase.from("stops")
        .select("event_id,sequence,type,facility_name,address,city,appt_start,appt_end,instructions")
        .in("event_id", eventIds)
    : { data: [] };

  const stopsByEvent = new Map<string, StopRow[]>();
  for (const s of (stops ?? []) as StopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(s);
    stopsByEvent.set(s.event_id, arr);
  }

  const lines: string[] = [];
  lines.push(`Load #${load.internal_load_id}${load.load_num ? ` (broker #${load.load_num})` : ""}`);
  if (load.broker) lines.push(`Broker: ${load.broker}`);
  if (customer && typeof customer === "object" && "name" in customer) {
    const c = customer as { name: string; short_name: string | null; mc_num: string | null; contact_name: string | null; contact_phone: string | null };
    lines.push(`Customer record: ${c.name}${c.short_name ? ` (${c.short_name})` : ""}${c.mc_num ? ` MC ${c.mc_num}` : ""}${c.contact_name ? ` · contact ${c.contact_name}${c.contact_phone ? ` ${c.contact_phone}` : ""}` : ""}`);
  }
  if (load.load_price != null) lines.push(`Rate: ${fmtMoney(load.load_price)}`);
  if (load.notes) lines.push(`Notes: ${load.notes}`);
  const accs = Array.isArray(load.accessorials) ? load.accessorials : [];
  if (accs.length > 0) {
    lines.push("Accessorials:");
    for (const a of accs as Array<{ category?: string; description?: string; amount?: number; status?: string; billable?: boolean }>) {
      lines.push(`  - ${a.category ?? "?"}${a.description ? ` (${a.description})` : ""}: ${a.amount != null ? fmtMoney(a.amount) : "—"}${a.status ? ` [${a.status}]` : ""}${a.billable === false ? " (not billable)" : ""}`);
    }
  }
  if (load.ref_nums) {
    try {
      const arr = JSON.parse(load.ref_nums);
      if (Array.isArray(arr) && arr.length) {
        lines.push(`Refs: ${arr.map((r: unknown) => typeof r === "object" && r ? `${(r as { label?: string }).label ?? ""}=${(r as { value?: string }).value ?? ""}` : String(r)).join(", ")}`);
      }
    } catch { /* ignore */ }
  }

  for (const ev of eventList) {
    const role = ev.relay_role ? ` [${ev.relay_role.toUpperCase()}]` : "";
    const del  = ev.deleted_at ? " (DELETED)" : "";
    lines.push(`\nLeg${role}${del}: ${fmtDate(ev.start)} → ${fmtDate(ev.end)} · status=${ev.status}`);
    if (ev.driver_name) lines.push(`  Driver: ${ev.driver_name}`);
    if (ev.driver_pay != null) lines.push(`  Driver pay: ${fmtMoney(ev.driver_pay)}`);
    if (ev.trailer_type) lines.push(`  Trailer type: ${ev.trailer_type}`);
    if (ev.notes) lines.push(`  Notes: ${ev.notes}`);
    const stopsForLeg = stopsByEvent.get(ev.id) ?? [];
    if (stopsForLeg.length > 0) {
      lines.push("  Stops:");
      for (const s of stopsForLeg.sort((a, b) => a.sequence - b.sequence)) {
        const where = [s.facility_name, s.address, s.city].filter(Boolean).join(", ") || "?";
        const when = s.appt_start ? ` @ ${fmtDate(s.appt_start)}${s.appt_end && s.appt_end !== s.appt_start ? `–${fmtDate(s.appt_end).slice(11)}` : ""}` : "";
        lines.push(`    ${s.sequence}. ${s.type}: ${where}${when}`);
        if (s.instructions) lines.push(`       Instructions: ${s.instructions.slice(0, 200)}`);
      }
    }
  }

  // Audit log: load-level + per-event, merged by changedAt
  type AuditEntry = { changedAt?: string; changedByName?: string; [k: string]: unknown };
  const allAudit: AuditEntry[] = [];
  if (Array.isArray(load.audit_log)) allAudit.push(...(load.audit_log as AuditEntry[]));
  for (const ev of eventList) {
    if (Array.isArray(ev.audit_log)) allAudit.push(...(ev.audit_log as AuditEntry[]));
  }
  if (allAudit.length > 0) {
    allAudit.sort((a, b) => (a.changedAt ?? "").localeCompare(b.changedAt ?? ""));
    lines.push(`\nAudit log (${allAudit.length} entries):`);
    for (const e of allAudit.slice(-20)) {
      const when = e.changedAt ? fmtDate(e.changedAt) : "?";
      const who  = e.changedByName ?? "?";
      // Just dump the keys that aren't who/when
      const rest = Object.entries(e).filter(([k]) => k !== "changedAt" && k !== "changedByName");
      const desc = rest.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      lines.push(`  ${when} · ${who}: ${desc}`);
    }
  }

  return lines.join("\n");
}

async function runGetPayrollSummary(orgId: string, input: { driverName?: unknown; weekStart?: unknown }): Promise<string> {
  const driverName = typeof input.driverName === "string" ? input.driverName.trim() : "";
  const weekStart  = typeof input.weekStart  === "string" ? input.weekStart.trim()  : null;
  if (!driverName) return "driverName required.";

  let adjQ = supabase.from("payroll_adjustments")
    .select("week_start,category,description,amount,created_at")
    .eq("org_id", orgId).eq("driver_name", driverName);
  let recQ = supabase.from("payroll_records")
    .select("week_start,total_pay,finalized_at,notes")
    .eq("org_id", orgId).eq("driver_name", driverName);
  if (weekStart) {
    adjQ = adjQ.eq("week_start", weekStart);
    recQ = recQ.eq("week_start", weekStart);
  }
  const [adjRes, recRes] = await Promise.all([
    adjQ.order("week_start", { ascending: false }).limit(50),
    recQ.order("week_start", { ascending: false }).limit(20),
  ]);

  const lines: string[] = [];
  lines.push(`Payroll for ${driverName}${weekStart ? ` (week ${weekStart})` : ""}:`);

  const records = (recRes.data ?? []) as Array<{ week_start: string; total_pay: number | string; finalized_at: string; notes: string | null }>;
  if (records.length > 0) {
    lines.push(`\nFinalized records (${records.length}):`);
    for (const r of records) {
      lines.push(`  Week ${r.week_start}: ${fmtMoney(Number(r.total_pay))} · finalized ${fmtDate(r.finalized_at)}${r.notes ? ` · ${r.notes}` : ""}`);
    }
  } else {
    lines.push("\nNo finalized pay records found.");
  }

  const adjustments = (adjRes.data ?? []) as Array<{ week_start: string; category: string; description: string | null; amount: number | string; created_at: string }>;
  if (adjustments.length > 0) {
    lines.push(`\nAdjustments (${adjustments.length}):`);
    for (const a of adjustments) {
      const amt = Number(a.amount);
      const sign = amt >= 0 ? "+" : "";
      lines.push(`  ${a.week_start} · ${a.category}: ${sign}${fmtMoney(amt)}${a.description ? ` (${a.description})` : ""}`);
    }
  } else {
    lines.push("\nNo adjustments found.");
  }

  return lines.join("\n");
}

async function runAddAccessorial(orgId: string, input: Record<string, unknown>): Promise<string> {
  const rawId = typeof input.loadId === "string" ? input.loadId.trim() : "";
  const category = typeof input.category === "string" ? input.category : "";
  const amount = Number(input.amount);
  if (!rawId)                                 return "loadId required.";
  if (!["detention", "lumper", "layover", "scale_ticket", "other"].includes(category)) {
    return `Invalid category '${category}'. Must be one of: detention, lumper, layover, scale_ticket, other.`;
  }
  if (!Number.isFinite(amount) || amount <= 0) return "amount must be a positive number.";

  // Resolve load (uuid or internal_load_id) under this org.
  let q = supabase.from("loads").select("id,internal_load_id,load_num,broker,accessorials,audit_log").eq("org_id", orgId);
  q = /^\d+$/.test(rawId) ? q.eq("internal_load_id", parseInt(rawId, 10)) : q.eq("id", rawId);
  const { data: load, error: fetchErr } = await q.maybeSingle();
  if (fetchErr) return `Error fetching load: ${fetchErr.message}`;
  if (!load)    return `Load '${rawId}' not found.`;

  const description = typeof input.description === "string" ? input.description : undefined;
  const billable    = typeof input.billable    === "boolean" ? input.billable    : true;
  const status      = typeof input.status      === "string"  ? input.status      : "requested";
  const payToDriver = typeof input.payToDriver === "boolean" ? input.payToDriver : false;

  const newAcc = {
    id: crypto.randomUUID(),
    category, amount, billable, status, payToDriver,
    ...(description ? { description } : {}),
  };

  const existingAccs = Array.isArray(load.accessorials) ? load.accessorials : [];
  const updatedAccs  = [...existingAccs, newAcc];

  const existingAudit = Array.isArray(load.audit_log) ? load.audit_log : [];
  const auditEntry = {
    changedAt: new Date().toISOString(),
    changedByName: "AI Assistant",
    accessorialsChanged: [{
      action: "added" as const,
      category,
      ...(description ? { description } : {}),
      amount,
    }],
  };
  const updatedAudit = [...existingAudit, auditEntry];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updErr } = await supabase
    .from("loads")
    .update({ accessorials: updatedAccs, audit_log: updatedAudit } as any)
    .eq("id", load.id)
    .eq("org_id", orgId);
  if (updErr) return `Error saving: ${updErr.message}`;

  const descPart = description ? ` (${description})` : "";
  return `Added ${category}${descPart} for ${fmtMoney(amount)} to Load #${load.internal_load_id}${load.load_num ? ` (broker #${load.load_num})` : ""}${load.broker ? ` — ${load.broker}` : ""}. Status: ${status}${billable ? ", billable" : ", not billable"}${payToDriver ? ", flows to driver pay" : ""}.`;
}

async function executeTool(orgId: string, name: string, input: unknown): Promise<string> {
  const safe = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  try {
    if (name === "search_loads")        return await runSearchLoads(orgId, safe);
    if (name === "get_load_details")    return await runGetLoadDetails(orgId, safe);
    if (name === "get_payroll_summary") return await runGetPayrollSummary(orgId, safe);
    if (name === "add_accessorial")     return await runAddAccessorial(orgId, safe);
    return `Unknown tool: ${name}`;
  } catch (err) {
    console.error(`[assistant.tool ${name}] error:`, err);
    return `Tool ${name} errored: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────

assistant.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<AssistantBody>().catch(() => null);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "validation_failed", errors: ["messages array required"] }, 400);
  }

  const now = new Date();
  const fromDefault = new Date(now); fromDefault.setDate(now.getDate() - 7);
  const toDefault   = new Date(now); toDefault.setDate(now.getDate() + 14);
  const fromIso = body.from ?? fromDefault.toISOString();
  const toIso   = body.to   ?? toDefault.toISOString();

  const [eventsRes, loadsRes, assetsRes, driversRes, customersRes, trailersRes, dispatchersRes, prefsRes] = await Promise.all([
    supabase.from("events")
      .select("id,load_id,asset_id,driver_id,driver_name,title,start,end,status,relay_role,trailer_id,trailer_type,driver_pay,notes,event_kind,non_revenue_type")
      .eq("org_id", orgId).is("deleted_at", null)
      .gte("end", fromIso).lte("start", toIso)
      .order("start", { ascending: true }),
    supabase.from("loads")
      .select("id,load_num,internal_load_id,broker,load_price,notes,accessorials,customer_id,ref_nums")
      .eq("org_id", orgId).is("deleted_at", null),
    supabase.from("assets").select("id,name,unit,type,hidden,motive_vehicle_id").eq("org_id", orgId),
    supabase.from("drivers").select("id,name,phone").eq("org_id", orgId).order("name"),
    supabase.from("customers").select("id,name,aliases,short_name,mc_num").eq("org_id", orgId).order("name"),
    supabase.from("trailers").select("id,name,trailer_number,category").eq("org_id", orgId).order("name"),
    supabase.from("dispatchers").select("id,name,is_default").eq("org_id", orgId).order("name"),
    supabase.from("driver_asset_prefs").select("asset_id,driver_id").eq("org_id", orgId),
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

  // Validate the timezone from the request body — fall back to UTC if it's
  // bogus so Intl.DateTimeFormat doesn't throw.
  const requestedTz = body.timezone?.trim() || "UTC";
  let timezone = "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: requestedTz }); timezone = requestedTz; }
  catch { /* invalid IANA name, stay on UTC */ }

  // Fire Motive in parallel with the prompt build (it has its own 10-min cache).
  const motiveLocations = await fetchMotiveLocations(orgId);

  const systemPrompt = buildContext({
    events, loads, stopsByEvent,
    assets:      (assetsRes.data ?? [])      as AssetRow[],
    drivers:     (driversRes.data ?? [])     as DriverRow[],
    customers:   (customersRes.data ?? [])   as CustomerRow[],
    trailers:    (trailersRes.data ?? [])    as TrailerRow[],
    dispatchers: (dispatchersRes.data ?? []) as DispatcherRow[],
    prefs:       (prefsRes.data ?? [])       as PrefRow[],
    motiveLocations,
    fromIso, toIso, timezone,
  });

  // Conversation messages start from the client's history. We mutate this
  // array as we tool-loop: each iteration appends the assistant turn (with
  // tool_use blocks) and the user turn (with tool_result blocks).
  const conversation: MessageParam[] = body.messages.map((m) => ({ role: m.role, content: m.content }));

  return stream(c, async (s) => {
    let aborted = false;
    s.onAbort(() => { aborted = true; });

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (aborted) return;

      const claudeStream = await client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages: conversation,
      });

      for await (const event of claudeStream) {
        if (aborted) return;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          await s.write(event.delta.text);
        }
      }

      const finalMessage = await claudeStream.finalMessage();
      const blocks = finalMessage.content as ContentBlock[];

      // If the model isn't requesting tools, we're done.
      if (finalMessage.stop_reason !== "tool_use") return;

      // Append the assistant turn (text + tool_use blocks) verbatim.
      conversation.push({ role: "assistant", content: blocks });

      // Run each tool the model asked for, in order, and append a user
      // turn with the matching tool_result blocks.
      const toolUseBlocks = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const toolResults = await Promise.all(toolUseBlocks.map(async (b) => {
        const result = await executeTool(orgId, b.name, b.input);
        return { type: "tool_result" as const, tool_use_id: b.id, content: result };
      }));
      conversation.push({ role: "user", content: toolResults });

      // Loop continues — Claude reads tool results and answers (or calls more tools).
    }

    // Hit the iteration ceiling — let the user know.
    await s.write("\n\n[Tool loop exceeded; some queries may not have completed.]");
  });
});

// Suppress unused-import warning when @anthropic-ai/sdk doesn't re-export TextBlock at runtime
type _Unused = TextBlock;

export default assistant;
