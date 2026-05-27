/**
 * One-time import: copy historical odometer readings from a CSV
 * (exported from the my-calendar database) into the FleetCal
 * fleet. Maps the old uuid asset ids to the new bigint asset ids
 * by matching the asset's `unit` number — works for any carrier
 * whose old + new systems keep unit numbers consistent.
 *
 * Auth strategy:
 *   • Old Supabase reads        — publishable anon key (RLS off on
 *                                  old project, fine for read-only).
 *   • FleetCal asset lookup     — Clerk bearer (one-shot, ~1 sec call).
 *   • FleetCal import endpoint  — long-lived org API key with the
 *                                  'odometer.import' scope. Use this
 *                                  for the bulk write so token TTL
 *                                  isn't a concern.
 *
 * Usage:
 *   ODOMETER_CSV=/Users/thema/Downloads/odometer_readings_rows.csv \
 *   OLD_SUPA_URL="https://vgglyebsbbgooqmguzmi.supabase.co" \
 *   OLD_SUPA_KEY="<old publishable key>" \
 *   FLEETCAL_API_URL="https://fleetcalapi-production.up.railway.app" \
 *   FLEETCAL_API_KEY="fck_..." \
 *   FLEETCAL_CLERK_BEARER="eyJ..." \
 *   npx tsx scripts/import-old-odometer-readings.ts
 *
 * Idempotency: the endpoint dedups on (asset_id, calendar_day_utc).
 * Re-running after a partial failure picks up where it left off.
 */

import { readFileSync } from "node:fs";

const ODOMETER_CSV         = process.env.ODOMETER_CSV;
const OLD_SUPA_URL         = process.env.OLD_SUPA_URL || "https://vgglyebsbbgooqmguzmi.supabase.co";
const OLD_SUPA_KEY         = process.env.OLD_SUPA_KEY;
const FLEETCAL_API_URL     = process.env.FLEETCAL_API_URL;
const FLEETCAL_API_KEY     = process.env.FLEETCAL_API_KEY;
const FLEETCAL_CLERK_BEARER = process.env.FLEETCAL_CLERK_BEARER;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!ODOMETER_CSV)          fail("ODOMETER_CSV (path to CSV file) required");
if (!OLD_SUPA_KEY)          fail("OLD_SUPA_KEY required");
if (!FLEETCAL_API_URL)      fail("FLEETCAL_API_URL required");
if (!FLEETCAL_API_KEY)      fail("FLEETCAL_API_KEY required (must carry scope 'odometer.import')");
if (!FLEETCAL_CLERK_BEARER) fail("FLEETCAL_CLERK_BEARER required (for one-time asset lookup — see header)");

// ── CSV parsing ───────────────────────────────────────────────────────

interface CsvRow {
  asset_uuid:  string;
  miles:       number;
  recorded_at: string;   // YYYY-MM-DD
  notes:       string;
}

function parseCsv(path: string): CsvRow[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  // Header: id, asset_id, miles, recorded_at, notes, created_at
  // We only need asset_id (uuid), miles, recorded_at, notes.
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Naive CSV split — notes column doesn't contain commas in the
    // sample. If a future CSV has quoted commas, swap this for a
    // real CSV parser.
    const parts = lines[i].split(",");
    if (parts.length < 6) continue;
    rows.push({
      asset_uuid:  parts[1],
      miles:       Number(parts[2]),
      recorded_at: parts[3],
      notes:       parts[4],
    });
  }
  return rows;
}

// ── Mapping helpers ───────────────────────────────────────────────────

async function fetchOldAssetUnits(uuids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (uuids.length === 0) return out;
  const url = `${OLD_SUPA_URL}/rest/v1/assets?select=id,unit,label&id=in.(${uuids.join(",")})`;
  const res = await fetch(url, {
    headers: {
      apikey:        OLD_SUPA_KEY as string,
      Authorization: `Bearer ${OLD_SUPA_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`old supabase assets fetch ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{ id: string; unit: string | null; label: string | null }>;
  for (const r of rows) {
    if (r.unit) out.set(r.id, r.unit);
  }
  return out;
}

async function fetchFleetcalAssetsByUnit(): Promise<Map<string, number>> {
  const res = await fetch(`${FLEETCAL_API_URL}/v1/assets`, {
    headers: {
      Authorization: `Bearer ${FLEETCAL_CLERK_BEARER}`,
    },
  });
  if (!res.ok) {
    throw new Error(`fleetcal assets fetch ${res.status}: ${await res.text()} — your bearer is probably expired; grab a fresh one (await window.Clerk.session.getToken() in the browser console) and retry`);
  }
  const body = (await res.json()) as { assets: Array<{ id: number; unit: string | null; name: string }> };
  const m = new Map<string, number>();
  for (const a of body.assets) {
    if (a.unit) m.set(a.unit, a.id);
  }
  return m;
}

// ── Import ────────────────────────────────────────────────────────────

interface ImportReading {
  assetId:      number;
  odometerMiles: number;
  capturedAt:   string;     // ISO timestamp
}

interface ImportResponse {
  inserted:    number;
  duplicates:  number;
  outOfWindow: number;
  failed:      Array<{ identifier: string; error: string }>;
}

async function postBatch(readings: ImportReading[]): Promise<ImportResponse> {
  const res = await fetch(`${FLEETCAL_API_URL}/v1/odometer-readings/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key":    FLEETCAL_API_KEY as string,
    },
    body: JSON.stringify({ readings }),
  });
  if (!res.ok) throw new Error(`import ${res.status}: ${await res.text()}`);
  return (await res.json()) as ImportResponse;
}

async function main() {
  console.log(`Reading CSV: ${ODOMETER_CSV}`);
  const rows = parseCsv(ODOMETER_CSV!);
  console.log(`  ${rows.length} rows`);

  const distinctUuids = Array.from(new Set(rows.map(r => r.asset_uuid)));
  console.log(`  ${distinctUuids.length} distinct old asset uuids`);

  console.log("Looking up old asset → unit number…");
  const uuidToUnit = await fetchOldAssetUnits(distinctUuids);
  console.log(`  resolved ${uuidToUnit.size} units`);

  console.log("Looking up FleetCal assets by unit…");
  const unitToAssetId = await fetchFleetcalAssetsByUnit();
  console.log(`  ${unitToAssetId.size} assets in FleetCal`);

  // Build the final uuid → FleetCal asset_id map. Print unmatched
  // units so the user knows what to fix on the FleetCal side.
  const uuidToAssetId = new Map<string, number>();
  const unmatched: Array<{ uuid: string; unit: string }> = [];
  for (const [uuid, unit] of uuidToUnit) {
    const id = unitToAssetId.get(unit);
    if (id != null) uuidToAssetId.set(uuid, id);
    else unmatched.push({ uuid, unit });
  }

  if (unmatched.length > 0) {
    console.log("\nWARNING — these old assets don't have a FleetCal counterpart with the same unit number:");
    for (const u of unmatched) {
      console.log(`  uuid=${u.uuid}  unit=${u.unit}`);
    }
    console.log("Their readings will be skipped. Add the assets in FleetCal with matching unit numbers if you want them imported.\n");
  }

  // Translate rows to import payloads.
  const payload: ImportReading[] = [];
  const skipped: Array<{ row: CsvRow; reason: string }> = [];
  for (const r of rows) {
    const assetId = uuidToAssetId.get(r.asset_uuid);
    if (assetId == null) { skipped.push({ row: r, reason: "no asset match" }); continue; }
    if (!Number.isFinite(r.miles) || r.miles <= 0) { skipped.push({ row: r, reason: "bad miles" }); continue; }
    if (!r.recorded_at) { skipped.push({ row: r, reason: "no date" }); continue; }
    payload.push({
      assetId,
      odometerMiles: r.miles,
      capturedAt:    new Date(`${r.recorded_at}T00:00:00.000Z`).toISOString(),
    });
  }

  console.log(`\nPayload ready: ${payload.length} readings to import (${skipped.length} skipped)`);

  const BATCH_SIZE = 200;
  let inserted = 0;
  let duplicates = 0;
  let outOfWindow = 0;
  const failed: Array<{ identifier: string; error: string }> = [];

  for (let i = 0; i < payload.length; i += BATCH_SIZE) {
    const slice = payload.slice(i, i + BATCH_SIZE);
    process.stdout.write(`Posting batch ${Math.floor(i / BATCH_SIZE) + 1} (${slice.length} rows)… `);
    const r = await postBatch(slice);
    console.log(`+${r.inserted} new, ${r.duplicates} dup, ${r.outOfWindow} out-of-window, ${r.failed.length} failed`);
    inserted    += r.inserted;
    duplicates  += r.duplicates;
    outOfWindow += r.outOfWindow;
    failed.push(...r.failed);
  }

  console.log(`\nDone.\n  inserted:     ${inserted}\n  duplicates:   ${duplicates}\n  out-of-window: ${outOfWindow}\n  failed:       ${failed.length}\n  skipped:      ${skipped.length}`);
  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const f of failed.slice(0, 20)) console.log(`  ${f.identifier}: ${f.error}`);
    if (failed.length > 20) console.log(`  …and ${failed.length - 20} more`);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
