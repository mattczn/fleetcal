/**
 * Suppress missing-POD reminders on pre-May-23 Alvys-imported loads.
 *
 * Background
 * ----------
 * The `runMissingPodSweep` cron sends a "We still need the POD" push
 * to drivers when an event status='delivered' has no load_documents
 * row with kind='pod'. After we imported ~2,000 historical Alvys loads
 * (all flipped to status='delivered'), drivers started receiving
 * spurious reminders for loads that were completed weeks/months ago
 * in Alvys.
 *
 * Strategy
 * --------
 * Insert a synthetic load_documents row (kind='pod', notes='legacy
 * paperwork already handled in Alvys') for every event matching:
 *
 *   • loads.imported_source = 'alvys'
 *   • event.start < 2026-05-23  (the cutoff the user specified — loads
 *                                before this date have all their
 *                                paperwork already resolved in Alvys)
 *   • event.status = 'delivered'  (only delivered events trigger the
 *                                  sweep; pending/cancelled are no-ops)
 *   • no existing load_documents row with kind='pod' for that load
 *
 * The synthetic doc has no real storage blob — `storage_path` points
 * to a sentinel ("alvys-legacy-pod") so anyone clicking "view POD" in
 * the UI gets a graceful 404 rather than a broken image. We don't
 * insert blob bytes; the row is purely a sweep-suppressor.
 *
 * Idempotent: storage_path is UNIQUE so re-running just skips the
 * already-stamped loads.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/mark-pre-may23-paperwork-complete.ts \
 *     --org=org_3Cgzom31hVxbq6WR3FjVTbL6K3t
 *   ... add --apply to write ...
 *
 * Optional:
 *   --before=YYYY-MM-DD   override the cutoff (default 2026-05-23)
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY  = process.argv.includes("--apply");
const ORG_ID = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);
const BEFORE = process.argv.find(a => a.startsWith("--before="))?.slice("--before=".length) ?? "2026-05-23";

if (!ORG_ID) { console.error("Missing --org=ORG_ID"); process.exit(1); }

const URL = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL || !KEY) { console.error("Missing SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(1); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(URL, KEY, { auth: { persistSession: false } });

function log(...xs: unknown[]): void { console.log(...xs); }

interface CandidateRow {
  event_id: string;
  load_id:  string;
  start:    string;
}

async function main(): Promise<void> {
  log(APPLY ? "▶  apply mode" : "🔍 dry-run mode");
  log(`   org=${ORG_ID}  cutoff (event.start <) ${BEFORE}`);
  log("");

  // ── Stage 1: candidate events ────────────────────────────────────
  // Imported Alvys loads, delivered, started before the cutoff.
  const candidates: CandidateRow[] = [];
  const PAGE = 1000;
  let off = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (fc as any)
      .from("events")
      .select("id, load_id, start, loads:loads!inner(imported_source)")
      .eq("org_id", ORG_ID)
      .eq("status", "delivered")
      .eq("loads.imported_source", "alvys")
      .is("deleted_at", null)
      .lt("start", BEFORE)
      .order("id", { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) { log(`events fetch failed at ${off}: ${error.message}`); process.exit(2); }
    const batch = (data ?? []) as Array<{ id: string; load_id: string; start: string }>;
    if (batch.length === 0) break;
    for (const r of batch) candidates.push({ event_id: r.id, load_id: r.load_id, start: r.start });
    if (batch.length < PAGE) break;
    off += batch.length;
  }
  log(`Candidate events: ${candidates.length}`);

  // ── Stage 2: filter out loads that already have a POD doc ────────
  const loadIds = [...new Set(candidates.map(c => c.load_id))];
  const haveSomePod = new Set<string>();
  const BATCH = 200;
  for (let i = 0; i < loadIds.length; i += BATCH) {
    const slice = loadIds.slice(i, i + BATCH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (fc as any)
      .from("load_documents")
      .select("load_id")
      .in("load_id", slice)
      .eq("kind", "pod");
    for (const r of (data ?? []) as Array<{ load_id: string }>) haveSomePod.add(r.load_id);
  }
  log(`Loads already with a POD doc:   ${haveSomePod.size}`);

  // One synthetic POD per (load_id, event_id) pair — pick the FIRST
  // event per load so we only insert once per load. The sweep is
  // load-level so this is sufficient.
  const firstEventByLoad = new Map<string, CandidateRow>();
  for (const c of candidates) {
    if (haveSomePod.has(c.load_id)) continue;
    if (!firstEventByLoad.has(c.load_id)) firstEventByLoad.set(c.load_id, c);
  }
  const toStamp = [...firstEventByLoad.values()];
  log(`Loads needing synthetic POD:    ${toStamp.length}`);
  log("");

  if (!APPLY) {
    log("(dry-run — re-run with --apply to insert)");
    return;
  }

  // ── Stage 3: bulk insert in batches ──────────────────────────────
  let inserted = 0;
  let skipped  = 0;
  let errors   = 0;
  const INSERT_BATCH = 500;
  for (let i = 0; i < toStamp.length; i += INSERT_BATCH) {
    const slice = toStamp.slice(i, i + INSERT_BATCH);
    const rows = slice.map(c => ({
      event_id:     c.event_id,
      load_id:      c.load_id,
      org_id:       ORG_ID,
      storage_path: `${ORG_ID}/${c.event_id}/alvys-legacy-pod`,
      file_name:    "Alvys legacy POD (placeholder)",
      mime_type:    "application/octet-stream",
      size_bytes:   0,
      kind:         "pod",
      notes:        "Legacy paperwork already handled in Alvys — synthetic POD record to suppress missing-POD reminders. No blob exists at storage_path.",
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (fc as any).from("load_documents").insert(rows);
    if (error) {
      // UNIQUE on storage_path = re-run was already partial. Count as
      // skipped, not error.
      if ((error.message ?? "").toLowerCase().includes("duplicate") ||
          (error.message ?? "").toLowerCase().includes("unique")) {
        skipped += slice.length;
      } else {
        errors  += slice.length;
        log(`  ✗ insert batch ${i}: ${error.message}`);
      }
      continue;
    }
    inserted += slice.length;
    if (inserted % 2500 === 0 || inserted === toStamp.length) {
      log(`  inserted ${inserted}/${toStamp.length}`);
    }
  }

  log("");
  log("── Summary ──");
  log(`Inserted: ${inserted}`);
  log(`Skipped (already had row): ${skipped}`);
  log(`Errors:   ${errors}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
