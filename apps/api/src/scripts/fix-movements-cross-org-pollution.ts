/**
 * Remediate the cross-org movement pollution introduced by the too-narrow
 * UNIQUE(motive_period_id) constraint on the movements table.
 *
 * Background
 * ----------
 * The mirror_motive_period_to_movement trigger had an ON CONFLICT clause
 * keyed on motive_period_id alone. When a demo org and the prod org both
 * sync against overlapping Motive scope, the first-writing org claims
 * the row; every subsequent org's trigger ran the UPDATE branch on that
 * row instead of INSERT-ing its own, routing daily data to the wrong org.
 *
 * The migration 20260605_movements_org_scoped_unique.sql widens the
 * uniqueness to (org_id, motive_period_id). This script does the two
 * follow-on cleanups:
 *
 *   1. DELETE the polluted rows from the wrong-org movements table —
 *      i.e. rows whose motive_period_id maps to a motive_driving_periods
 *      row owned by a DIFFERENT org. Those are the trigger's misplaced
 *      writes; they should never have landed there.
 *
 *   2. Backfill the prod org's missing rows by walking every
 *      motive_driving_periods row that doesn't have a matching
 *      movements row in its own org, and INSERT-ing the right movement.
 *
 * Idempotent. Re-running is safe — pollution detection re-checks org
 * mismatch, backfill re-checks existence.
 *
 * IMPORTANT: Run AFTER the schema migration has been applied. Otherwise
 * the backfill inserts will hit the old UNIQUE constraint and either
 * silently UPDATE a wrong-org row again, or fail.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/fix-movements-cross-org-pollution.ts
 *     (dry-run — counts only)
 *
 *   npx tsx src/scripts/fix-movements-cross-org-pollution.ts --apply
 *     (deletes pollution + backfills)
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

const URL = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(1); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(URL, KEY, { auth: { persistSession: false } });

function log(...xs: unknown[]): void { console.log(...xs); }

interface MdpRow {
  id: number;
  org_id: string;
  vehicle_id: number;
  start_time: string;
  end_time: string | null;
  duration: number | null;
  miles: number | null;
  origin: string | null;
  destination: string | null;
  origin_lat: number | null;
  origin_lon: number | null;
  destination_lat: number | null;
  destination_lon: number | null;
}

interface MovementRow {
  id: string;
  org_id: string;
  motive_period_id: number;
}

async function main(): Promise<void> {
  log(APPLY ? "▶  apply mode" : "🔍 dry-run mode");
  log("");

  // ── Stage 1: identify pollution ─────────────────────────────────
  // Pull every movement row that has a motive_period_id, plus the
  // owning org of its corresponding motive_driving_periods row. Any
  // mismatch is pollution.
  log("Stage 1: scanning for pollution…");
  const pollutedIds: string[] = [];
  const pollutionByOrgPair = new Map<string, number>();   // "${wrongOrg} ← ${rightOrg}" → count
  const PAGE = 1000;
  let off = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (fc as any)
      .from("movements")
      .select("id, org_id, motive_period_id")
      .not("motive_period_id", "is", null)
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) { log(`✗ movements page fetch ${error.message}`); process.exit(2); }
    const batch = (data ?? []) as MovementRow[];
    if (batch.length === 0) break;

    // Lookup their motive_driving_periods rows in a batch
    const periodIds = batch.map(r => r.motive_period_id).filter(Boolean);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: mdps } = await (fc as any)
      .from("motive_driving_periods")
      .select("id, org_id")
      .in("id", periodIds);
    const ownerByPeriodId = new Map<number, string>();
    for (const m of (mdps ?? []) as Array<{ id: number; org_id: string }>) {
      ownerByPeriodId.set(m.id, m.org_id);
    }

    for (const mv of batch) {
      const owner = ownerByPeriodId.get(mv.motive_period_id);
      if (!owner) continue; // orphan — period was deleted? leave alone
      if (owner !== mv.org_id) {
        pollutedIds.push(mv.id);
        const key = `${mv.org_id} ← ${owner}`;
        pollutionByOrgPair.set(key, (pollutionByOrgPair.get(key) ?? 0) + 1);
      }
    }
    if (batch.length < PAGE) break;
    off += batch.length;
  }
  log(`  pollution found: ${pollutedIds.length} rows`);
  log("");
  log("  Polluted-by-org-pair:");
  for (const [k, n] of [...pollutionByOrgPair.entries()].sort((a, b) => b[1] - a[1])) {
    log(`    ${n.toString().padStart(6)}  ${k}`);
  }
  log("");

  // ── Stage 2: identify missing movements ────────────────────────
  // Walk motive_driving_periods, check each is mirrored to a movements
  // row in the same org. Collect missing → batch insert later.
  log("Stage 2: scanning for missing mirror rows…");
  const missingByOrg = new Map<string, MdpRow[]>();
  off = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (fc as any)
      .from("motive_driving_periods")
      .select("id, org_id, vehicle_id, start_time, end_time, duration, miles, origin, destination, origin_lat, origin_lon, destination_lat, destination_lon")
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) { log(`✗ mdp page fetch ${error.message}`); process.exit(2); }
    const batch = (data ?? []) as MdpRow[];
    if (batch.length === 0) break;

    // Pull existing same-org movement rows for these period_ids
    // (PostgREST .in() works in one round; combine with org filter via
    // separate query per org we see in the batch.)
    const orgsInBatch = [...new Set(batch.map(r => r.org_id))];
    const existsByPeriodOrg = new Set<string>();
    for (const o of orgsInBatch) {
      const ids = batch.filter(r => r.org_id === o).map(r => r.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: mv } = await (fc as any)
        .from("movements")
        .select("motive_period_id")
        .eq("org_id", o)
        .in("motive_period_id", ids);
      for (const r of (mv ?? []) as Array<{ motive_period_id: number }>) {
        existsByPeriodOrg.add(`${o}|${r.motive_period_id}`);
      }
    }

    for (const r of batch) {
      if (existsByPeriodOrg.has(`${r.org_id}|${r.id}`)) continue;
      if (!missingByOrg.has(r.org_id)) missingByOrg.set(r.org_id, []);
      missingByOrg.get(r.org_id)!.push(r);
    }
    if (batch.length < PAGE) break;
    off += batch.length;
  }
  let totalMissing = 0;
  for (const [, arr] of missingByOrg) totalMissing += arr.length;
  log(`  missing mirror rows: ${totalMissing}`);
  for (const [org, arr] of missingByOrg) {
    log(`    ${arr.length.toString().padStart(6)}  ${org}`);
  }
  log("");

  if (!APPLY) {
    log("(dry-run — re-run with --apply to delete pollution + backfill)");
    return;
  }

  // ── Stage 3: delete pollution ──────────────────────────────────
  log("Stage 3: deleting pollution…");
  const DEL_BATCH = 500;
  let deleted = 0;
  for (let i = 0; i < pollutedIds.length; i += DEL_BATCH) {
    const slice = pollutedIds.slice(i, i + DEL_BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (fc as any).from("movements").delete().in("id", slice);
    if (error) { log(`✗ delete batch ${i}: ${error.message}`); break; }
    deleted += slice.length;
    if (deleted % 2500 === 0 || deleted === pollutedIds.length) {
      log(`  deleted ${deleted}/${pollutedIds.length}`);
    }
  }
  log(`  deleted total: ${deleted}`);
  log("");

  // ── Stage 4: backfill missing mirror rows ──────────────────────
  // For each missing period, resolve the asset_id from
  // assets.motive_vehicle_id, then INSERT into movements. Re-uses the
  // same field mappings as the DB-level trigger function.
  log("Stage 4: backfilling missing mirror rows…");

  // Pre-fetch the (org_id, motive_vehicle_id) → asset_id map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: assets } = await (fc as any)
    .from("assets")
    .select("id, org_id, motive_vehicle_id")
    .not("motive_vehicle_id", "is", null);
  const assetByOrgVehicle = new Map<string, number>();
  for (const a of (assets ?? []) as Array<{ id: number; org_id: string; motive_vehicle_id: string }>) {
    assetByOrgVehicle.set(`${a.org_id}|${a.motive_vehicle_id}`, a.id);
  }

  const INSERT_BATCH = 500;
  let inserted = 0;
  let skippedNoAsset = 0;
  for (const [org, rows] of missingByOrg) {
    const insertRows = [];
    for (const r of rows) {
      const assetId = assetByOrgVehicle.get(`${r.org_id}|${r.vehicle_id}`);
      if (!assetId) { skippedNoAsset++; continue; }
      const duration_min = r.duration != null
        ? Math.max(0, Math.round(r.duration / 60))
        : (r.end_time
          ? Math.max(0, Math.round((new Date(r.end_time).getTime() - new Date(r.start_time).getTime()) / 60000))
          : null);
      insertRows.push({
        org_id: r.org_id,
        asset_id: assetId,
        source: "motive",
        motive_period_id: r.id,
        start_time: r.start_time,
        end_time: r.end_time,
        duration_min,
        miles: r.miles,
        origin: r.origin,
        destination: r.destination,
        origin_lat: r.origin_lat,
        origin_lon: r.origin_lon,
        destination_lat: r.destination_lat,
        destination_lon: r.destination_lon,
        created_by: "motive_sync_backfill",
        created_at: r.start_time,
      });
    }
    for (let i = 0; i < insertRows.length; i += INSERT_BATCH) {
      const slice = insertRows.slice(i, i + INSERT_BATCH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (fc as any).from("movements").insert(slice);
      if (error) { log(`✗ insert batch (org ${org}) ${i}: ${error.message}`); break; }
      inserted += slice.length;
      if (inserted % 2500 === 0) log(`  inserted ${inserted}/${totalMissing}`);
    }
  }
  log(`  inserted total: ${inserted}  (skipped no-asset: ${skippedNoAsset})`);

  log("");
  log("── Done ──");
  log(`Pollution deleted: ${deleted}`);
  log(`Backfilled rows:   ${inserted}`);
  log(`Skipped no-asset:  ${skippedNoAsset}  (vehicle has no matching asset record for that org)`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
