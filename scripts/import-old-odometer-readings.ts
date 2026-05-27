/**
 * One-time import: copy historical odometer readings from a CSV
 * (exported from the my-calendar database) into FleetCal.
 *
 * Maps old-system uuid asset ids to FleetCal assets by going through
 * unit numbers (which both systems share). The flow:
 *
 *   1. Read CSV → collect distinct old asset uuids.
 *   2. Query old Supabase to resolve each uuid → unit number.
 *   3. POST to /v1/odometer-readings/import sending `{ unit, miles,
 *      capturedAt }`. The API resolves unit → FleetCal asset_id
 *      server-side (no Clerk needed).
 *
 * Auth:
 *   • Old Supabase reads — publishable anon key (RLS off, read-only).
 *   • FleetCal import     — long-lived org API key with scope
 *                            'odometer.import'. No Clerk bearer
 *                            required.
 *
 * Usage:
 *   ODOMETER_CSV=/path/to/csv \
 *   OLD_SUPA_URL=... OLD_SUPA_KEY=... \
 *   FLEETCAL_API_URL=https://fleetcalapi-production.up.railway.app \
 *   FLEETCAL_API_KEY=fck_... \
 *   npx tsx scripts/import-old-odometer-readings.ts
 */

import { readFileSync } from "node:fs";

const ODOMETER_CSV     = process.env.ODOMETER_CSV;
const OLD_SUPA_URL     = process.env.OLD_SUPA_URL || "https://vgglyebsbbgooqmguzmi.supabase.co";
const OLD_SUPA_KEY     = process.env.OLD_SUPA_KEY;
const FLEETCAL_API_URL = process.env.FLEETCAL_API_URL;
const FLEETCAL_API_KEY = process.env.FLEETCAL_API_KEY;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!ODOMETER_CSV)     fail("ODOMETER_CSV (path to CSV file) required");
if (!OLD_SUPA_KEY)     fail("OLD_SUPA_KEY required");
if (!FLEETCAL_API_URL) fail("FLEETCAL_API_URL required");
if (!FLEETCAL_API_KEY) fail("FLEETCAL_API_KEY required (scope: odometer.import)");

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
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
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

// ── Old-system asset lookup ───────────────────────────────────────────

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

// ── Import ────────────────────────────────────────────────────────────

interface ImportReading {
  unit:          string;
  odometerMiles: number;
  capturedAt:    string;
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

  // Build payload — send by unit, server resolves to asset_id.
  const payload: ImportReading[] = [];
  const skipped: Array<{ row: CsvRow; reason: string }> = [];
  for (const r of rows) {
    const unit = uuidToUnit.get(r.asset_uuid);
    if (!unit) { skipped.push({ row: r, reason: "no unit for old uuid" }); continue; }
    if (!Number.isFinite(r.miles) || r.miles <= 0) { skipped.push({ row: r, reason: "bad miles" }); continue; }
    if (!r.recorded_at) { skipped.push({ row: r, reason: "no date" }); continue; }
    payload.push({
      unit,
      odometerMiles: r.miles,
      capturedAt:    new Date(`${r.recorded_at}T00:00:00.000Z`).toISOString(),
    });
  }

  console.log(`\nPayload: ${payload.length} readings (${skipped.length} skipped pre-flight)`);

  const BATCH_SIZE = 200;
  let inserted    = 0;
  let duplicates  = 0;
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

  console.log(`\nDone.\n  inserted:      ${inserted}\n  duplicates:    ${duplicates}\n  out-of-window: ${outOfWindow}\n  failed:        ${failed.length}\n  skipped:       ${skipped.length}`);
  if (failed.length > 0) {
    console.log("\nFailed sample:");
    for (const f of failed.slice(0, 20)) console.log(`  ${f.identifier}: ${f.error}`);
    if (failed.length > 20) console.log(`  …and ${failed.length - 20} more`);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
