/**
 * my-calendar → FleetCal event bridge.
 *
 * Fills in driver / asset / per-load driver_pay / accurate start+end
 * on the Alvys-imported FleetCal loads, by joining against the
 * matching my-calendar event via alvys_load_id.
 *
 * Phase 1 of the importer (stage 1 invoice-only) set:
 *   - broker, customer_id, load_price, billing_status
 *   - one event on the Unassigned asset, driver_id=NULL, start=invoice_date@09:00
 *
 * Phase 2 (stage 2 of the importer) pulled loaded_miles from my-calendar.
 *
 * Phase 3 (THIS script) pulls the rest:
 *   - driver_name      (my-calendar has this as a plain text field already)
 *   - driver_id        (matched against FleetCal drivers by first-name)
 *   - asset_id         (matched against FleetCal assets by unit number,
 *                       decoded from my-calendar's rid via driver_overrides
 *                       + the hardcoded RESOURCES table)
 *   - driver_pay       (my-calendar.driver_pay)
 *   - start / end      (my-calendar's accurate times, vs our invoice-date stub)
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/bridge-mycalendar-to-fleetcal.ts \
 *     --org=org_3Cgzom31hVxbq6WR3FjVTbL6K3t
 *   ... add --apply to write ...
 *
 * Idempotent — re-runnable. Each update is bounded to fields that come
 * from my-calendar; never touches load_price, broker, customer_id, etc.
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY  = process.argv.includes("--apply");
const ORG_ID = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);

if (!ORG_ID) {
  console.error("Missing --org=ORG_ID");
  process.exit(1);
}

const FC_URL = process.env.SUPABASE_URL ?? "";
const FC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const MC_URL = process.env.MYCAL_SUPABASE_URL ?? "https://vgglyebsbbgooqmguzmi.supabase.co";
const MC_KEY = process.env.MYCAL_SUPABASE_SERVICE_KEY ?? "";

if (!FC_URL || !FC_KEY || !MC_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / MYCAL_SUPABASE_SERVICE_KEY");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(FC_URL, FC_KEY, { auth: { persistSession: false } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mc: SupabaseClient<any> = createClient(MC_URL, MC_KEY, { auth: { persistSession: false } });

function log(...xs: unknown[]): void { console.log(...xs); }

// ── RESOURCES decoder ────────────────────────────────────────────────────
//
// The hardcoded list lives in my-calendar/index.html. driver_overrides
// in my-calendar's Supabase supersedes individual entries. The drivers
// (extras) table covers rid ≥ 15.
//
// We only need the UNIT field (asset matching). driver_name comes
// directly from the event row, so no name-from-rid lookup needed.

interface ResourceEntry { rid: number; name: string; unit: string }

// Verbatim from my-calendar/index.html — last sync 2026-06-04.
const RESOURCES: ResourceEntry[] = [
  { rid: 0,  name: "Unassigned", unit: "—"     },
  { rid: 1,  name: "Extra",      unit: "2027"  },
  { rid: 2,  name: "Eiber",      unit: "2024"  },
  { rid: 3,  name: "Fernando",   unit: "149062"},
  { rid: 4,  name: "Eduardo",    unit: "2022"  },
  { rid: 5,  name: "Pablo",      unit: "2023"  },
  { rid: 6,  name: "Julio",      unit: "412863"},
  { rid: 7,  name: "Kevin",      unit: "422465"},
  { rid: 8,  name: "Alonzo",     unit: "2021"  },
  { rid: 9,  name: "Miguel",     unit: "2025"  },
  { rid: 10, name: "Albino",     unit: "214733"},
  { rid: 11, name: "Rodrigo",    unit: "2026"  },
  { rid: 12, name: "Lennin",     unit: "431985"},
  { rid: 13, name: "Blade",      unit: "01"    },
  { rid: 14, name: "Dilson",     unit: "264495"},
];

// Local overrides — applied LAST, beat both my-calendar overrides and
// RESOURCES. Use this when the user tells us a truck assignment has
// changed since my-calendar's driver_overrides was last updated.
//
// Kevin (rid=7): my-calendar says 422465, but he's now on 296084.
const UNIT_OVERRIDES: Record<number, string> = {
  7: "296084",
};

// Driver-name aliases — for my-calendar events whose driver_name is a
// nickname / partial / shortened form that doesn't first-name-match
// any FleetCal driver. Key is the my-calendar text (case-insensitive),
// value is the FleetCal driver's full name as stored in drivers.name.
//
// Coverage based on first dry-run unresolved list:
//   Blade (125)       — nickname for Blessing Munguri
//   Dilson (24)       — short for Adilson Peroza
//   Lenny (7)         — short for Lennin Ramirez
//   Jean Carlos (8)   — exact, but FleetCal stores last name; first-name
//                       match misses because my-calendar text has TWO words
//
// Pure-junk entries are routed to NAME_SKIPS below instead — we leave
// the driver_name column blank rather than storing garbage.
const NAME_ALIASES: Record<string, string> = {
  "blade":       "Blessing Munguri",
  "dilson":      "Adilson Peroza",
  "lenny":       "Lennin Ramirez",
  "jean carlos": "Jean Carlos Polo",
};

// Driver-name strings that should be treated as "no driver" — usually
// my-calendar placeholder rids or one-off data-entry mistakes. We do
// not store these as plaintext driver_name; the row keeps NULL.
const NAME_SKIPS = new Set<string>([
  "extra",       // rid=1 placeholder ("any extra driver")
  "unassigned",
  "—",
  "-",
]);

// ── Build rid → unit map by overlaying sources ──────────────────────────

async function buildRidToUnit(): Promise<Map<number, string>> {
  const map = new Map<number, string>();

  // Layer 1: RESOURCES baseline
  for (const r of RESOURCES) map.set(r.rid, r.unit);

  // Layer 2: my-calendar's driver_overrides
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: ovr, error: ovrErr } = await (mc as any)
    .from("driver_overrides")
    .select("id, unit");
  if (ovrErr) {
    log(`⚠ driver_overrides fetch failed (continuing with RESOURCES only): ${ovrErr.message}`);
  } else {
    for (const o of (ovr ?? []) as Array<{ id: number; unit: string | null }>) {
      if (o.unit && o.unit !== "-") map.set(o.id, o.unit);
    }
  }

  // Layer 3: explicit UNIT_OVERRIDES (user-supplied truth)
  for (const [rid, unit] of Object.entries(UNIT_OVERRIDES)) {
    map.set(Number(rid), unit);
  }

  return map;
}

// ── FleetCal roster ─────────────────────────────────────────────────────

interface FleetcalDriver { id: number; name: string | null; first_name: string | null; last_name: string | null }
interface FleetcalAsset  { id: number; name: string; unit: string | null }

async function loadFleetcalRoster(): Promise<{
  driverByFirstName: Map<string, FleetcalDriver>;
  driverByFullName:  Map<string, FleetcalDriver>;
  assetByUnit:       Map<string, FleetcalAsset>;
  unassignedAssetId: number | null;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: drivers, error: drErr } = await (fc as any)
    .from("drivers")
    .select("id, name, first_name, last_name")
    .eq("org_id", ORG_ID);
  if (drErr) throw new Error(`drivers fetch failed: ${drErr.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: assets, error: asErr } = await (fc as any)
    .from("assets")
    .select("id, name, unit, type")
    .eq("org_id", ORG_ID);
  if (asErr) throw new Error(`assets fetch failed: ${asErr.message}`);

  const dRows = (drivers ?? []) as FleetcalDriver[];
  const aRows = (assets ?? []) as Array<FleetcalAsset & { type: string | null }>;

  const driverByFirstName = new Map<string, FleetcalDriver>();
  const driverByFullName  = new Map<string, FleetcalDriver>();
  for (const d of dRows) {
    const first = (d.first_name ?? d.name?.split(" ")[0] ?? "").trim().toLowerCase();
    const full  = (d.name ?? `${d.first_name ?? ""} ${d.last_name ?? ""}`).trim().toLowerCase();
    if (first) driverByFirstName.set(first, d);
    if (full)  driverByFullName.set(full, d);
  }
  const assetByUnit = new Map<string, FleetcalAsset>();
  let unassignedAssetId: number | null = null;
  for (const a of aRows) {
    if (a.unit) assetByUnit.set(String(a.unit).trim(), a);
    if (a.type === "Unassigned" || a.name === "Unassigned") unassignedAssetId = a.id;
  }
  return { driverByFirstName, driverByFullName, assetByUnit, unassignedAssetId };
}

// ── Walk imported FleetCal loads + bridge ────────────────────────────────

interface ImportedLoad {
  id: string;
  alvys_load_id: string;
  events: Array<{
    id: string;
    asset_id: number | null;
    driver_id: number | null;
    driver_name: string | null;
    driver_pay: number | null;
    start: string | null;
    end: string | null;
  }>;
}

interface MyCalEvent {
  alvys_load_id: string | null;
  rid: number | null;
  driver_name: string | null;
  driver_pay: number | null;
  leg_driver_pay: number | null;
  start: string;
  end: string;
  released: boolean | null;
  pod_uploaded: boolean | null;
}

const tally = {
  fcLoadsScanned:      0,
  matchedInMyCalendar: 0,
  noMatchInMyCalendar: 0,
  updatesApplied:      0,
  driverResolved:      0,
  driverUnresolved:    0,
  assetResolved:       0,
  assetUnresolved:     0,
  driverPaySet:        0,
  errors:              0,
};
const unresolvedDrivers = new Map<string, number>();
const unresolvedAssets  = new Map<string, number>(); // key: unit
const unresolvedRids    = new Map<number, number>(); // rids we couldn't decode

async function main(): Promise<void> {
  log(APPLY ? "▶  apply mode" : "🔍 dry-run mode");
  log(`   org=${ORG_ID}`);
  log("");

  // Build decoders
  const ridToUnit = await buildRidToUnit();
  log(`rid→unit decoder built (${ridToUnit.size} entries)`);
  const { driverByFirstName, driverByFullName, assetByUnit, unassignedAssetId } = await loadFleetcalRoster();
  log(`FleetCal roster: ${driverByFirstName.size} drivers (first-name keyed), ${assetByUnit.size} assets (unit keyed)`);
  log(`Unassigned asset id: ${unassignedAssetId}`);
  log("");

  // Page through imported FleetCal loads with their event(s).
  type ImportedRow = ImportedLoad;
  const imported: ImportedRow[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows, error } = await (fc as any)
      .from("loads")
      .select("id, alvys_load_id, events:events(id, asset_id, driver_id, driver_name, driver_pay, start, end)")
      .eq("org_id", ORG_ID)
      .eq("imported_source", "alvys")
      .not("alvys_load_id", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      log(`Loads fetch failed at offset ${offset}: ${error.message}`);
      process.exit(2);
    }
    const batch = (rows ?? []) as ImportedRow[];
    imported.push(...batch);
    if (batch.length < PAGE) break;
    offset += batch.length;
  }
  log(`Found ${imported.length} imported FleetCal loads to bridge`);
  log("");

  // Build a map of alvys_load_id → my-calendar event in chunks (avoids URL bloat).
  const allAlvysIds = imported.map(l => l.alvys_load_id);
  const mcEventsByAlvysId = new Map<string, MyCalEvent>();
  const MC_BATCH = 100;
  for (let i = 0; i < allAlvysIds.length; i += MC_BATCH) {
    const slice = allAlvysIds.slice(i, i + MC_BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (mc as any)
      .from("events")
      .select("alvys_load_id, rid, driver_name, driver_pay, leg_driver_pay, start, end, released, pod_uploaded")
      .in("alvys_load_id", slice)
      .is("deleted_at", null);
    if (error) {
      log(`my-calendar events fetch failed at i=${i}: ${error.message}`);
      tally.errors++;
      continue;
    }
    for (const e of (data ?? []) as MyCalEvent[]) {
      if (e.alvys_load_id) mcEventsByAlvysId.set(e.alvys_load_id, e);
    }
  }
  log(`Matched ${mcEventsByAlvysId.size} of ${imported.length} FleetCal loads against my-calendar`);
  log("");

  // Walk + apply
  for (const load of imported) {
    tally.fcLoadsScanned++;
    const fcEvent = load.events?.[0];
    if (!fcEvent) continue;
    const mcEvent = mcEventsByAlvysId.get(load.alvys_load_id);
    if (!mcEvent) { tally.noMatchInMyCalendar++; continue; }
    tally.matchedInMyCalendar++;

    // Resolve driver: alias → full-name → first-name. Skip junk.
    let driverId: number | null = null;
    let driverName: string | null = null;
    const rawName = (mcEvent.driver_name ?? "").trim();
    const lowerName = rawName.toLowerCase();
    const isNumeric = /^\d+$/.test(rawName);
    if (rawName && !NAME_SKIPS.has(lowerName) && !isNumeric) {
      const aliasTarget = NAME_ALIASES[lowerName];
      const matched =
        (aliasTarget && driverByFullName.get(aliasTarget.toLowerCase())) ??
        driverByFullName.get(lowerName) ??
        driverByFirstName.get(rawName.split(/\s+/)[0].toLowerCase());
      if (matched) {
        driverId = matched.id;
        driverName = matched.name ?? `${matched.first_name ?? ""} ${matched.last_name ?? ""}`.trim();
        tally.driverResolved++;
      } else {
        unresolvedDrivers.set(rawName, (unresolvedDrivers.get(rawName) ?? 0) + 1);
        tally.driverUnresolved++;
        driverName = rawName; // store the text even if FK can't resolve
      }
    }

    // Resolve asset by rid → unit → FleetCal asset.
    let assetId: number | null = null;
    if (mcEvent.rid != null) {
      const unit = ridToUnit.get(mcEvent.rid);
      if (!unit) {
        unresolvedRids.set(mcEvent.rid, (unresolvedRids.get(mcEvent.rid) ?? 0) + 1);
      } else if (unit === "—" || unit === "-") {
        // rid 0 = Unassigned in RESOURCES — keep the FleetCal Unassigned asset
        assetId = unassignedAssetId;
        tally.assetResolved++;
      } else {
        const asset = assetByUnit.get(unit);
        if (asset) {
          assetId = asset.id;
          tally.assetResolved++;
        } else {
          unresolvedAssets.set(unit, (unresolvedAssets.get(unit) ?? 0) + 1);
          tally.assetUnresolved++;
        }
      }
    }

    // Driver pay — prefer driver_pay; fall back to leg_driver_pay
    // (relay legs sometimes only have leg_driver_pay set).
    const driverPay = mcEvent.driver_pay ?? mcEvent.leg_driver_pay ?? null;
    if (driverPay != null) tally.driverPaySet++;

    // Build the update. Only include fields where we have a definitive
    // value; leave others alone so the FleetCal data we have already
    // (or any later manual edits) survives.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: Record<string, any> = {};
    if (assetId  != null) update.asset_id    = assetId;
    if (driverId != null) update.driver_id   = driverId;
    if (driverName)       update.driver_name = driverName;
    if (driverPay != null) update.driver_pay = driverPay;
    if (mcEvent.start)    update.start = mcEvent.start;
    if (mcEvent.end)      update.end   = mcEvent.end;

    if (Object.keys(update).length === 0) continue;

    if (!APPLY) {
      tally.updatesApplied++;
      if (tally.updatesApplied <= 20) {
        log(`  → ${load.alvys_load_id.slice(0, 8)} :: driver=${driverName ?? "—"} asset=${assetId ?? "—"} pay=$${driverPay ?? "—"}`);
      }
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (fc as any).from("events").update(update).eq("id", fcEvent.id);
    if (upErr) {
      tally.errors++;
      log(`  ✗ ${load.alvys_load_id.slice(0, 8)}: ${upErr.message}`);
      continue;
    }
    tally.updatesApplied++;
  }

  // ── Report ────────────────────────────────────────────────────────────
  log("");
  log("── Summary ─────────────────────────────────────────────────────");
  log(`FleetCal loads scanned:           ${tally.fcLoadsScanned}`);
  log(`Matched in my-calendar:           ${tally.matchedInMyCalendar}`);
  log(`No match in my-calendar:          ${tally.noMatchInMyCalendar}  (likely loads we missed in the Alvys paging gap)`);
  log(`${APPLY ? "Updates applied" : "Updates that would apply"}: ${tally.updatesApplied}`);
  log(`Driver FK resolved:               ${tally.driverResolved}`);
  log(`Driver FK unresolved:             ${tally.driverUnresolved}`);
  log(`Asset FK resolved:                ${tally.assetResolved}`);
  log(`Asset FK unresolved:              ${tally.assetUnresolved}`);
  log(`Per-load driver_pay set:          ${tally.driverPaySet}`);
  log(`Errors:                           ${tally.errors}`);

  if (unresolvedDrivers.size > 0) {
    log("");
    log("── Unresolved driver names (need FleetCal driver or alias) ──");
    log("name,occurrences");
    [...unresolvedDrivers.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => log(`  "${n}",${c}`));
  }
  if (unresolvedAssets.size > 0) {
    log("");
    log("── Unresolved truck units (no matching FleetCal asset) ──");
    log("unit,occurrences");
    [...unresolvedAssets.entries()].sort((a, b) => b[1] - a[1]).forEach(([u, c]) => log(`  ${u},${c}`));
  }
  if (unresolvedRids.size > 0) {
    log("");
    log("── Unresolved rids (no entry in RESOURCES + driver_overrides + UNIT_OVERRIDES) ──");
    log("rid,occurrences");
    [...unresolvedRids.entries()].sort((a, b) => b[1] - a[1]).forEach(([r, c]) => log(`  ${r},${c}`));
  }
  log("");
  if (!APPLY) log("(dry-run — re-run with --apply to actually write)");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
