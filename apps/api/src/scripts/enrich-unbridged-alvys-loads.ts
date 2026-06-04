/**
 * Enrich the 758 historical FleetCal loads that the my-calendar bridge
 * couldn't match — fill them in with real data from Alvys.
 *
 * Background
 * ----------
 * The original Alvys importer ran in invoice-only mode (POST
 * /invoices/search returns only refs, not stops). That landed every
 * load on the Unassigned asset with start/end = invoice_date @ 09:00
 * and no addresses. The my-calendar bridge then enriched ~1,274 of
 * those with real driver / asset / appointment data. ~758 didn't
 * match any my-calendar event so they remain stubs — these are the
 * loads where the dashboard shows "Mar 25" on a card that actually
 * ran the prior week.
 *
 * Fresh probe: POST /loads/search on the Alvys integration API works
 * and returns full Stops with addresses, coordinates, AppointmentDate,
 * ArrivedAt, DepartedAt. We can use it to upgrade those stubs.
 *
 * Strategy
 * --------
 * Default target: events whose asset is the org's Unassigned asset
 * AND whose load is `imported_source='alvys'`. We won't touch
 * already-bridged events because my-calendar's per-leg data is more
 * authoritative for those (real driver pay, actual pickup times).
 *
 * For each target:
 *   - Find matching Alvys load (paginate /loads/search by date range,
 *     build alvys_load_id → AlvysLoad map in memory)
 *   - Update event.start = first pickup AppointmentDate (naive MT)
 *   - Update event.end   = last delivery AppointmentDate (naive MT)
 *   - Replace stops for that event with the Alvys stop list
 *     (pickup, intermediate, delivery — addresses + coordinates +
 *     appointment times)
 *   - Update load.load_num, load.order_num
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/enrich-unbridged-alvys-loads.ts \
 *     --org=org_3Cgzom31hVxbq6WR3FjVTbL6K3t \
 *     --from=2026-01-01 --to=2026-06-04
 *   ... add --apply to write ...
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY         = process.argv.includes("--apply");
const BRIDGED_ONLY  = process.argv.includes("--bridged-only");
const ORG   = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);
const FROM  = process.argv.find(a => a.startsWith("--from="))?.slice("--from=".length) ?? "2026-01-01";
const TO    = process.argv.find(a => a.startsWith("--to="))?.slice("--to=".length)   ?? new Date().toISOString().slice(0, 10);
if (!ORG) { console.error("Missing --org=ORG_ID"); process.exit(1); }

const FC_URL = process.env.SUPABASE_URL ?? "";
const FC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!FC_URL || !FC_KEY) { console.error("Missing SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(1); }

const ALVYS_AUTH_URL = "https://auth.alvys.com/oauth/token";
const ALVYS_API_BASE = "https://integrations.alvys.com/api/p/v1.0";
const ALVYS_AUDIENCE = "https://api.alvys.com/public/";
const ALVYS_CLIENT_ID     = process.env.ALVYS_CLIENT_ID ?? "";
const ALVYS_CLIENT_SECRET = process.env.ALVYS_CLIENT_SECRET ?? "";
if (!ALVYS_CLIENT_ID || !ALVYS_CLIENT_SECRET) { console.error("Missing ALVYS_CLIENT_ID / SECRET"); process.exit(1); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(FC_URL, FC_KEY, { auth: { persistSession: false } });

function log(...xs: unknown[]): void { console.log(...xs); }

// ── Alvys auth + types ──────────────────────────────────────────────
interface AlvysToken { token: string; expiresAt: number }
let cachedToken: AlvysToken | null = null;
async function alvysToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(ALVYS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: ALVYS_CLIENT_ID, client_secret: ALVYS_CLIENT_SECRET,
      audience: ALVYS_AUDIENCE,
    }),
  });
  if (!res.ok) throw new Error(`Alvys auth failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cachedToken.token;
}

interface AlvysAddress { Street?: string; City?: string; State?: string; ZipCode?: string }
interface AlvysCoords  { Latitude?: string | number; Longitude?: string | number }
interface AlvysStop {
  Id?: string;
  StopType?: "Pickup" | "Delivery" | string;
  Address?: AlvysAddress;
  Coordinates?: AlvysCoords;
  AppointmentDate?: string;       // "2026-02-09T10:00:00-07:00"
  AppointmentDateEnd?: string;
  ArrivedAt?: string;
  DepartedAt?: string;
  ScheduleType?: string;
  Status?: string;
  Sequence?: number;
  CompanyId?: string;             // → look up name via /locations/search
}
interface AlvysLocation {
  Id?: string;
  Name?: string;
  PhysicalAddress?: AlvysAddress;
}
interface AlvysLoad {
  Id?: string;
  LoadNumber?: string;
  OrderNumber?: string;
  PONumber?: string;
  CustomerId?: string;
  CustomerName?: string;
  Status?: string;
  LoadType?: string;
  Stops?: AlvysStop[];
}

async function alvysSearchLocationsPage(token: string, page: number): Promise<{ items: AlvysLocation[]; total: number }> {
  const res = await fetch(`${ALVYS_API_BASE}/locations/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ Page: page, PageSize: 100 }),
  });
  if (!res.ok) throw new Error(`/locations/search failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { Items?: AlvysLocation[]; Total?: number };
  return { items: body.Items ?? [], total: body.Total ?? 0 };
}

async function alvysSearchLoadsPage(token: string, page: number, fromIso: string, toIso: string): Promise<{ items: AlvysLoad[]; total: number }> {
  const res = await fetch(`${ALVYS_API_BASE}/loads/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      Page: page,
      PageSize: 100,
      Status: ["Delivered", "Invoiced", "Paid"],
      DateRange: { From: fromIso, To: toIso },
    }),
  });
  if (!res.ok) throw new Error(`/loads/search failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { Items?: AlvysLoad[]; Total?: number };
  return { items: body.Items ?? [], total: body.Total ?? 0 };
}

// ── Helpers ─────────────────────────────────────────────────────────
// "2026-02-09T10:00:00-07:00" → "2026-02-09T10:00"
// We treat the Alvys local-with-offset string as naive Mountain Time
// since the org operates in MT and the offsets in the data are MT
// (-07:00 in standard, -06:00 in DST). FleetCal stores naive MT.
function naiveOf(iso: string | undefined): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  return m ? m[1] : null;
}
function combineAddress(addr: AlvysAddress | undefined): string | null {
  if (!addr) return null;
  const parts = [addr.Street, addr.City, addr.State, addr.ZipCode].map(s => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}
function asNum(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const tally = {
  fcUnbridgedScanned:   0,
  alvysLoadsFetched:    0,
  matchedInAlvys:       0,
  noAlvysMatch:         0,
  noUsablePickupDate:   0,
  eventsUpdated:        0,
  loadsUpdated:         0,
  stopsInserted:        0,
  errors:               0,
};
const unmatchedSamples: Array<{ alvys_load_id: string; broker: string | null }> = [];

async function main(): Promise<void> {
  log(APPLY ? "▶  apply mode" : "🔍 dry-run mode");
  log(`   org=${ORG}  window=${FROM} → ${TO}`);
  log("");

  // ── 1. Unassigned asset id ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: ua } = await (fc as any).from("assets").select("id").eq("org_id", ORG).eq("type", "Unassigned").maybeSingle();
  if (!ua) { log("✗ could not find Unassigned asset for this org"); process.exit(2); }
  const unassignedId = ua.id as number;
  log(`Unassigned asset id: ${unassignedId}`);

  // ── 2. Target FleetCal events ──
  //
  // Default mode: events on Unassigned with driver_name + driver_pay
  // both NULL — the original stubs the my-calendar bridge didn't
  // touch. Full enrichment (start/end + load_num + ref_nums + stops).
  //
  // --bridged-only mode: events where driver_name IS NOT NULL on
  // Alvys-imported loads — these got driver/asset/pay/start-end from
  // my-calendar but still lack load_num, ref_nums, and stops.
  // Conservative enrichment: load_num + ref_nums always; stops only
  // for non-relay loads (we skip relays because Alvys returns one
  // stop list per load and splitting it across legs requires
  // judgment we don't want to automate).
  interface TargetRow {
    load_id:   string;
    alvys_id:  string;
    broker:    string | null;
    event_id:  string;
  }
  const targets: TargetRow[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q = (fc as any)
      .from("events")
      .select("id, asset_id, driver_name, driver_pay, load:loads!inner(id, alvys_load_id, broker, imported_source)")
      .eq("org_id", ORG)
      .eq("load.imported_source", "alvys")
      .not("load.alvys_load_id", "is", null)
      .is("deleted_at", null);
    if (BRIDGED_ONLY) {
      // Bridged events have driver_name set.
      q = q.not("driver_name", "is", null);
    } else {
      // Default: untouched stubs only.
      q = q.eq("asset_id", unassignedId).is("driver_name", null).is("driver_pay", null);
    }
    const { data, error } = await q.range(offset, offset + PAGE - 1);
    if (error) { log(`events fetch failed: ${error.message}`); process.exit(2); }
    const batch = (data ?? []) as Array<{ id: string; load: { id: string; alvys_load_id: string; broker: string | null } | { id: string; alvys_load_id: string; broker: string | null }[] }>;
    if (batch.length === 0) break;
    for (const row of batch) {
      const l = Array.isArray(row.load) ? row.load[0] : row.load;
      if (!l?.alvys_load_id) continue;
      targets.push({ load_id: l.id, alvys_id: l.alvys_load_id, broker: l.broker, event_id: row.id });
    }
    if (batch.length < PAGE) break;
    offset += batch.length;
  }
  tally.fcUnbridgedScanned = targets.length;
  log(`Mode: ${BRIDGED_ONLY ? "BRIDGED-ONLY (preserve my-calendar times, add load_num/ref_nums/stops)" : "DEFAULT (full enrichment of stubs)"}`);
  log(`Target events: ${targets.length}`);

  // In bridged-only mode, detect relay loads (load_id with >1 event)
  // so we can skip stops for them.
  const relayLoadIds = new Set<string>();
  if (BRIDGED_ONLY) {
    const loadIds = [...new Set(targets.map(t => t.load_id))];
    const countByLoad = new Map<string, number>();
    const COUNT_BATCH = 100;
    for (let i = 0; i < loadIds.length; i += COUNT_BATCH) {
      const slice = loadIds.slice(i, i + COUNT_BATCH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (fc as any).from("events").select("load_id").in("load_id", slice).is("deleted_at", null);
      for (const r of (data ?? []) as Array<{ load_id: string }>) {
        countByLoad.set(r.load_id, (countByLoad.get(r.load_id) ?? 0) + 1);
      }
    }
    for (const [lid, n] of countByLoad) if (n > 1) relayLoadIds.add(lid);
    log(`Relay loads in target set: ${relayLoadIds.size} (stops will be skipped for these)`);
  }
  log("");

  // ── 3a. Pull Alvys locations (for facility_name on stops) ──
  const token = await alvysToken();
  log(`Got Alvys token, fetching /locations/search…`);
  const locationsById = new Map<string, string>();   // Id → Name
  {
    let lpage = 1;
    while (true) {
      const pr = await alvysSearchLocationsPage(token, lpage);
      for (const loc of pr.items) {
        if (loc.Id && loc.Name) locationsById.set(loc.Id, loc.Name);
      }
      if (pr.items.length < 100 || locationsById.size >= pr.total) break;
      lpage++;
    }
    log(`  ${locationsById.size} locations indexed for facility_name lookup`);
  }

  // ── 3b. Pull Alvys loads in the window, build map ──
  log(`Fetching /loads/search…`);
  const alvysById = new Map<string, AlvysLoad>();
  let page = 1;
  let total = 0;
  while (true) {
    let attempt = 0;
    let pageRes: { items: AlvysLoad[]; total: number } | null = null;
    while (attempt < 3) {
      try {
        pageRes = await alvysSearchLoadsPage(token, page, FROM, TO);
        break;
      } catch (err) {
        attempt++;
        const backoffMs = 1000 * Math.pow(2, attempt);
        log(`  page ${page} attempt ${attempt} failed: ${(err as Error).message}; sleeping ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
    if (!pageRes) { log(`✗ page ${page} failed after retries`); break; }
    total = pageRes.total;
    for (const l of pageRes.items) {
      if (l.Id) alvysById.set(l.Id, l);
    }
    tally.alvysLoadsFetched += pageRes.items.length;
    log(`  page ${page}: ${pageRes.items.length} loads (running total: ${alvysById.size}/${total})`);
    if (pageRes.items.length < 100 || alvysById.size >= total) break;
    page++;
  }
  log(`Pulled ${alvysById.size} Alvys loads total.`);
  log("");

  // ── 4. Walk targets, enrich (parallel batches) ──
  //
  // Each target needs 4 sequential Supabase writes (event update,
  // load update, stops delete, stops insert). 728 × 4 × ~150ms RTT
  // from a laptop is ~7 min serially. Running batches of 8 in
  // parallel drops that to ~1 min and gives the progress log
  // something to print.
  const CONCURRENCY = 8;
  let processed = 0;
  const logProgress = (): void => {
    if (processed % 25 === 0 || processed === targets.length) {
      log(`  progress: ${processed}/${targets.length}  (matched=${tally.matchedInAlvys}, applied=${tally.eventsUpdated}, errors=${tally.errors})`);
    }
  };

  async function processOne(t: typeof targets[number]): Promise<void> {
    const al = alvysById.get(t.alvys_id);
    if (!al) {
      tally.noAlvysMatch++;
      if (unmatchedSamples.length < 10) unmatchedSamples.push({ alvys_load_id: t.alvys_id, broker: t.broker });
      return;
    }
    tally.matchedInAlvys++;

    const stops = (al.Stops ?? []).slice().sort((a, b) => (a.Sequence ?? 0) - (b.Sequence ?? 0));
    const pickup = stops.find(s => (s.StopType ?? "").toLowerCase() === "pickup") ?? stops[0];
    const delivery = stops.slice().reverse().find(s => (s.StopType ?? "").toLowerCase() === "delivery") ?? stops[stops.length - 1];

    const pickupNaive = naiveOf(pickup?.AppointmentDate ?? pickup?.ArrivedAt);
    const deliveryNaive = naiveOf(delivery?.AppointmentDate ?? delivery?.DepartedAt ?? delivery?.ArrivedAt);

    if (!pickupNaive) {
      tally.noUsablePickupDate++;
      return;
    }

    if (!APPLY) {
      if (tally.eventsUpdated < 15) {
        const addr = combineAddress(pickup?.Address);
        log(`  → ${t.alvys_id.slice(0, 8)} :: ${t.broker ?? "—"} :: pickup=${pickupNaive} ${addr ?? "(no addr)"} :: delivery=${deliveryNaive ?? "?"}`);
      }
      tally.eventsUpdated++;
      tally.loadsUpdated++;
      tally.stopsInserted += stops.length;
      return;
    }

    // event.start / end — only in default mode.
    // Bridged events already have accurate times from my-calendar
    // and we don't want broker-appointment times to clobber them.
    if (!BRIDGED_ONLY) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: evErr } = await (fc as any).from("events").update({
        start: pickupNaive,
        end:   deliveryNaive ?? pickupNaive,
      }).eq("id", t.event_id);
      if (evErr) { tally.errors++; log(`  ✗ event update ${t.alvys_id.slice(0,8)}: ${evErr.message}`); return; }
      tally.eventsUpdated++;
    }
    // In bridged mode we leave the event row alone (my-calendar's
    // start/end are authoritative).

    // load: load_num + ref_nums (jsonb)
    const refNums: Array<{ label: string; value: string }> = [];
    if (al.OrderNumber) refNums.push({ label: "Order #", value: al.OrderNumber });
    if (al.PONumber)    refNums.push({ label: "PO #",    value: al.PONumber    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loadPatch: Record<string, any> = { load_num: al.LoadNumber ?? null };
    if (refNums.length > 0) loadPatch.ref_nums = refNums;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: ldErr } = await (fc as any).from("loads").update(loadPatch).eq("id", t.load_id);
    if (ldErr) { tally.errors++; log(`  ✗ load update ${t.alvys_id.slice(0,8)}: ${ldErr.message}`); return; }
    tally.loadsUpdated++;

    // Stops: skip entirely for relay loads in bridged-only mode.
    // Alvys returns one stop list per load; my-calendar splits relays
    // into 2 legs with their own (partial) stop sets. Auto-splitting
    // the Alvys list across legs is judgment we don't want to make.
    if (BRIDGED_ONLY && relayLoadIds.has(t.load_id)) return;

    // Replace stops (delete then insert — idempotent on re-run)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: delErr } = await (fc as any).from("stops").delete().eq("event_id", t.event_id);
    if (delErr) { tally.errors++; log(`  ✗ stops delete ${t.alvys_id.slice(0,8)}: ${delErr.message}`); return; }

    const stopRows = stops.map((s, idx) => ({
      org_id:         ORG,
      event_id:       t.event_id,
      sequence:       idx + 1,
      type:           (s.StopType ?? "").toLowerCase() === "pickup" ? "pickup" : (s.StopType ?? "").toLowerCase() === "delivery" ? "delivery" : "stop",
      facility_name:  s.CompanyId ? (locationsById.get(s.CompanyId) ?? null) : null,
      address:        combineAddress(s.Address),
      city:           s.Address?.City ?? null,
      state:          s.Address?.State ?? null,
      lat:            asNum(s.Coordinates?.Latitude),
      lng:            asNum(s.Coordinates?.Longitude),
      appt_start:     naiveOf(s.AppointmentDate),
      appt_end:       naiveOf(s.AppointmentDateEnd),
      arrived_at:     naiveOf(s.ArrivedAt),
      schedule_type:  s.ScheduleType ?? null,
      timezone:       "America/Denver",
      geocode_status: (s.Coordinates?.Latitude && s.Coordinates?.Longitude) ? "success" : "pending",
    }));
    if (stopRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: stErr } = await (fc as any).from("stops").insert(stopRows);
      if (stErr) { tally.errors++; log(`  ✗ stops insert ${t.alvys_id.slice(0,8)}: ${stErr.message}`); return; }
      tally.stopsInserted += stopRows.length;
    }
  }

  // Process in parallel batches.
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(t => processOne(t)));
    processed += batch.length;
    logProgress();
  }

  // ── Report ──
  log("");
  log("── Summary ──");
  log(`Target unbridged events:        ${tally.fcUnbridgedScanned}`);
  log(`Alvys loads fetched in window:  ${tally.alvysLoadsFetched}`);
  log(`Matched in Alvys:               ${tally.matchedInAlvys}`);
  log(`No Alvys match:                 ${tally.noAlvysMatch}`);
  log(`Skipped — no usable pickup:     ${tally.noUsablePickupDate}`);
  log(`Events ${APPLY ? "updated" : "would update"}:               ${tally.eventsUpdated}`);
  log(`Loads ${APPLY ? "updated" : "would update"}:                ${tally.loadsUpdated}`);
  log(`Stops ${APPLY ? "inserted" : "would insert"}:               ${tally.stopsInserted}`);
  log(`Errors:                         ${tally.errors}`);
  if (unmatchedSamples.length) {
    log("");
    log("── Sample unmatched-in-Alvys ──");
    for (const u of unmatchedSamples) log(`  ${u.alvys_load_id}   ${u.broker ?? "—"}`);
  }
  if (!APPLY) log("\n(dry-run — re-run with --apply to write)");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
