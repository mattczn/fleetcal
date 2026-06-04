/**
 * Soft-delete pre-Alvys-import duplicate events + their loads.
 *
 * Context: from late April through May 22 the user was running
 * FleetCal in parallel with my-calendar — entering loads in both as
 * a soak-test. Now that the Alvys historical import + my-calendar
 * bridge are in, those manual entries are duplicates of the real
 * (imported) loads. They double-count revenue, driver pay, and miles.
 *
 * Target: events whose load has `imported_source IS NULL` (i.e. NOT
 * created by the Alvys importer) AND whose start falls in
 * [FROM, TO_EXCLUSIVE). Configurable via flags.
 *
 * Safety:
 *   - Soft delete only (sets deleted_at). Recoverable from the Trash UI
 *     for the standard auto-expire window.
 *   - Both events AND loads are soft-deleted, so revenue/payroll/miles
 *     surfaces stop counting them (those read deleted_at IS NULL).
 *   - For relays (multi-leg loads), we verify ALL legs would be deleted
 *     before touching the load. Mixed-period relays (only one leg in
 *     range) are skipped — both legs are left alone, no orphaning.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/delete-pre-import-duplicates.ts \
 *     --org=org_3Cgzom31hVxbq6WR3FjVTbL6K3t
 *   ... add --apply to write ...
 *
 * Optional:
 *   --from=YYYY-MM-DD          earliest start (inclusive). default: 2026-04-15
 *   --to=YYYY-MM-DD            cutoff (EXCLUSIVE). default: 2026-05-23
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ORG_ID = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);
const FROM   = process.argv.find(a => a.startsWith("--from="))?.slice("--from=".length) ?? "2026-04-15";
const TO_EX  = process.argv.find(a => a.startsWith("--to="))?.slice("--to=".length)     ?? "2026-05-23";

if (!ORG_ID) { console.error("Missing --org=ORG_ID"); process.exit(1); }

const URL = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(URL, KEY, { auth: { persistSession: false } });

function log(...xs: unknown[]): void { console.log(...xs); }

async function main(): Promise<void> {
  log(APPLY ? "▶  apply mode" : "🔍 dry-run mode");
  log(`   org=${ORG_ID}`);
  log(`   window: start in [${FROM}, ${TO_EX})  (so up through ${TO_EX} minus one day)`);
  log("");

  // ── Stage 1: fetch every candidate event ─────────────────────────
  type Candidate = { id: string; load_id: string; start: string; asset_id: number | null };
  const candidates: Candidate[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (fc as any)
      .from("events")
      .select("id, load_id, start, asset_id, loads:loads!inner(imported_source)")
      .eq("org_id", ORG_ID)
      .is("loads.imported_source", null)
      .is("deleted_at", null)
      .gte("start", FROM)
      .lt("start", TO_EX)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      log(`events fetch failed at offset ${offset}: ${error.message}`);
      process.exit(2);
    }
    const batch = ((data ?? []) as Candidate[]);
    candidates.push(...batch);
    if (batch.length < PAGE) break;
    offset += batch.length;
  }
  log(`Candidate events:                 ${candidates.length}`);

  const candidateEventIds = new Set(candidates.map(c => c.id));
  const candidateLoadIds = [...new Set(candidates.map(c => c.load_id))];
  log(`Unique loads touched:             ${candidateLoadIds.length}`);

  // ── Stage 2: verify relay safety ─────────────────────────────────
  // For every touched load, fetch all its non-deleted events. If a
  // load has any event OUTSIDE our candidate set (e.g. a relay where
  // the delivery leg is in our window but the pickup is earlier and
  // would survive), exclude that load+event entirely so we never
  // leave a relay half-deleted.
  const safeLoadIds = new Set<string>();
  const skippedLoadIds = new Set<string>();
  const BATCH = 100;
  for (let i = 0; i < candidateLoadIds.length; i += BATCH) {
    const slice = candidateLoadIds.slice(i, i + BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: legs, error } = await (fc as any)
      .from("events")
      .select("id, load_id")
      .in("load_id", slice)
      .is("deleted_at", null);
    if (error) { log(`leg lookup failed: ${error.message}`); process.exit(2); }
    const byLoad = new Map<string, string[]>();
    for (const e of (legs ?? []) as Array<{ id: string; load_id: string }>) {
      if (!byLoad.has(e.load_id)) byLoad.set(e.load_id, []);
      byLoad.get(e.load_id)!.push(e.id);
    }
    for (const loadId of slice) {
      const legIds = byLoad.get(loadId) ?? [];
      const allCovered = legIds.length > 0 && legIds.every(id => candidateEventIds.has(id));
      if (allCovered) safeLoadIds.add(loadId);
      else            skippedLoadIds.add(loadId);
    }
  }
  log(`Safe-to-delete loads:             ${safeLoadIds.size}`);
  log(`Skipped (mixed-period relay):     ${skippedLoadIds.size}`);

  const eventIdsToDelete = candidates
    .filter(c => safeLoadIds.has(c.load_id))
    .map(c => c.id);
  const loadIdsToDelete  = [...safeLoadIds];
  log(`Events to soft-delete:            ${eventIdsToDelete.length}`);
  log(`Loads to soft-delete:             ${loadIdsToDelete.length}`);
  log("");

  if (!APPLY) {
    log("── Spread by day (events to delete) ──");
    const byDay = new Map<string, number>();
    for (const c of candidates) {
      if (!safeLoadIds.has(c.load_id)) continue;
      const day = c.start.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    [...byDay.entries()].sort().forEach(([d, n]) => log(`  ${d}: ${n}`));
    log("");
    log("(dry-run — re-run with --apply to actually soft-delete)");
    return;
  }

  // ── Stage 3: apply soft delete ────────────────────────────────────
  const now = new Date().toISOString();
  const UPSERT_BATCH = 500;

  let eventsDone = 0;
  for (let i = 0; i < eventIdsToDelete.length; i += UPSERT_BATCH) {
    const slice = eventIdsToDelete.slice(i, i + UPSERT_BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (fc as any).from("events").update({ deleted_at: now }).in("id", slice);
    if (error) { log(`event soft-delete failed at i=${i}: ${error.message}`); process.exit(2); }
    eventsDone += slice.length;
    log(`  events soft-deleted: ${eventsDone}/${eventIdsToDelete.length}`);
  }

  let loadsDone = 0;
  for (let i = 0; i < loadIdsToDelete.length; i += UPSERT_BATCH) {
    const slice = loadIdsToDelete.slice(i, i + UPSERT_BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (fc as any).from("loads").update({ deleted_at: now }).in("id", slice);
    if (error) { log(`load soft-delete failed at i=${i}: ${error.message}`); process.exit(2); }
    loadsDone += slice.length;
    log(`  loads soft-deleted:  ${loadsDone}/${loadIdsToDelete.length}`);
  }

  log("");
  log("── Done ──");
  log(`Events soft-deleted: ${eventsDone}`);
  log(`Loads soft-deleted:  ${loadsDone}`);
  log("Recoverable via the Trash UI for the standard expiry window.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
