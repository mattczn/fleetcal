/**
 * One-shot backfill: stamp asset_id on motive_odometer_readings rows
 * whose Motive vehicle_id matches an asset's motive_vehicle_id.
 *
 * Background
 * ----------
 * The 2026-05-29 migration added asset_id to motive_odometer_readings
 * with the intent of source-agnostic storage. The migration's own
 * comment said "Set on Motive readings too once we have the
 * vehicle_id→asset_id lookup done at write time" — that step was
 * never wired into snapshotOdometers, so every daily snapshot since
 * then has landed as asset_id=NULL.
 *
 * The dashboard's Total Miles tile joins readings by asset_id, so
 * every org with only Motive-sourced rows reads 0. The ingest fix
 * (companion commit) populates asset_id on new rows; this script
 * heals the backlog.
 *
 * What it does
 * ------------
 *   For every row where asset_id IS NULL AND vehicle_id IS NOT NULL,
 *   look up assets.id WHERE motive_vehicle_id = vehicle_id AND
 *   org_id = row.org_id. If exactly one match, write asset_id. If
 *   no match (deleted asset, never imported), leave alone and log.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/backfill-odometer-asset-ids.ts            # dry-run
 *   npx tsx src/scripts/backfill-odometer-asset-ids.ts --apply    # write
 *   npx tsx src/scripts/backfill-odometer-asset-ids.ts --org=ORG  # scope
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const APPLY   = process.argv.includes("--apply");
const ORG_ARG = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = createClient(url, key, { auth: { persistSession: false } }) as any;

interface ReadingRow {
  id: number;
  org_id: string;
  vehicle_id: number | null;
}

interface AssetRow {
  id: number;
  motive_vehicle_id: number | null;
}

const tally = { total: 0, linked: 0, noVehicleId: 0, noMatch: 0, errors: 0 };
const orphans: Array<{ readingId: number; orgId: string; vehicleId: number }> = [];

async function main() {
  console.log(APPLY ? "▶  apply mode: writing changes" : "🔍 dry-run mode: no writes");
  if (ORG_ARG) console.log(`   scoped to org: ${ORG_ARG}`);
  console.log("");

  // Per-org asset cache: each org's vehicle_id→asset_id map is fetched
  // once.
  const assetMapByOrg = new Map<string, Map<number, number>>();

  const PAGE = 1000;
  let offset = 0;

  while (true) {
    let q = supabase
      .from("motive_odometer_readings")
      .select("id, org_id, vehicle_id")
      .is("asset_id", null)
      .not("vehicle_id", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (ORG_ARG) q = q.eq("org_id", ORG_ARG);
    const { data, error } = await q;
    if (error) {
      console.error("Page fetch failed:", error);
      process.exit(2);
    }
    const rows = (data ?? []) as ReadingRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      tally.total++;
      if (row.vehicle_id == null) {
        tally.noVehicleId++;
        continue;
      }
      // Lazy-load the org's asset roster.
      let map = assetMapByOrg.get(row.org_id);
      if (!map) {
        const { data: assets, error: assetErr } = await supabase
          .from("assets")
          .select("id, motive_vehicle_id")
          .eq("org_id", row.org_id)
          .not("motive_vehicle_id", "is", null);
        if (assetErr) {
          console.error(`Asset fetch failed for org ${row.org_id}:`, assetErr);
          tally.errors++;
          continue;
        }
        map = new Map<number, number>();
        for (const a of (assets ?? []) as AssetRow[]) {
          if (a.motive_vehicle_id != null) map.set(a.motive_vehicle_id, a.id);
        }
        assetMapByOrg.set(row.org_id, map);
      }
      const assetId = map.get(row.vehicle_id);
      if (assetId == null) {
        tally.noMatch++;
        orphans.push({ readingId: row.id, orgId: row.org_id, vehicleId: row.vehicle_id });
        continue;
      }
      if (APPLY) {
        const { error: upErr } = await supabase
          .from("motive_odometer_readings")
          .update({ asset_id: assetId })
          .eq("id", row.id)
          .is("asset_id", null);
        if (upErr) {
          console.error(`  ✗ reading ${row.id}:`, upErr.message);
          tally.errors++;
          continue;
        }
      }
      tally.linked++;
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  console.log("");
  console.log("── Summary ─────────────────────────────────────────────");
  console.log(`Total scanned:    ${tally.total}`);
  console.log(`${APPLY ? "Linked" : "Would link"}:  ${tally.linked}`);
  console.log(`No vehicle_id:    ${tally.noVehicleId} (left alone)`);
  console.log(`No asset match:   ${tally.noMatch} (orphan vehicle ids — asset deleted or never imported)`);
  console.log(`Errors:           ${tally.errors}`);
  if (orphans.length > 0 && orphans.length <= 50) {
    console.log("");
    console.log("── Orphan readings (vehicle_id has no matching asset) ──");
    console.log("readingId,orgId,vehicleId");
    for (const o of orphans) {
      console.log(`${o.readingId},${o.orgId},${o.vehicleId}`);
    }
  } else if (orphans.length > 50) {
    console.log(`(${orphans.length} orphans — too many to list inline)`);
  }
  console.log("");
  if (!APPLY) {
    console.log("(dry-run — re-run with --apply to actually write)");
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(3);
});
