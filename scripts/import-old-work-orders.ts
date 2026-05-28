/**
 * One-time import: bring historical work orders from the old
 * maintenance system into FleetCal's maintenance_action_items table.
 *
 * Reads two CSVs from --csv-dir (defaults to ~/Downloads):
 *   maintenance_items_rows.csv  ← old work orders
 *   assets_rows.csv             ← old assets (for unit-number lookup)
 *
 * Joins old.asset_id (UUID) → unit number → new assets.id (bigint) or
 * trailers.id depending on old.type. Old `truck` rows land in
 * maintenance_action_items.asset_id; old `trailer` rows land in
 * maintenance_action_items.trailer_id. Unmappable rows still import
 * with both null (the new schema allows it) and get flagged in the
 * summary — the dispatcher can attach them later from the UI.
 *
 * Fields preserved per the user's "just the essentials" request:
 *   title, description, category, priority, status, out_of_service,
 *   completed_at (when status=done), created_at, updated_at, asset/trailer.
 * Fields intentionally dropped:
 *   scheduled_date, due_date, vendor, cost, pm_schedule_id, odometer,
 *   calendar_event_id, gcal_event_id, source, reviewed.
 *   (Re-add via the UI if needed; this is "get it in, refine later.")
 *
 * Idempotency: passes the OLD work order's UUID into description as a
 * trailing `[migrated-from <uuid>]` tag. Re-runs skip rows whose tag
 * already exists in the DB so a partial failure can resume safely.
 * Tags can be cleaned via SQL after the import settles.
 *
 * Usage:
 *   SUPABASE_URL=https://<project>.supabase.co \
 *   SUPABASE_SERVICE_KEY=<service-role-key> \
 *   ORG_ID=<your clerk org_id> \
 *   npx tsx scripts/import-old-work-orders.ts
 *
 * Optional flags:
 *   --csv-dir <path>   Directory containing the two CSVs (default ~/Downloads)
 *   --dry-run          Print summary only, don't insert.
 *
 * Get SUPABASE_SERVICE_KEY from: Supabase dashboard → Project Settings
 * → API → service_role secret. NEVER commit this. NEVER use it from
 * a browser. Local one-shot scripts only.
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const csvDirIdx = args.indexOf("--csv-dir");
const csvDir = csvDirIdx >= 0 ? args[csvDirIdx + 1]! : path.join(os.homedir(), "Downloads");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ORG_ID = process.env.ORG_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ORG_ID) {
  console.error("Missing env vars. Need SUPABASE_URL, SUPABASE_SERVICE_KEY, ORG_ID.");
  process.exit(1);
}

const ASSETS_CSV = path.join(csvDir, "assets_rows.csv");
const WOS_CSV    = path.join(csvDir, "maintenance_items_rows.csv");

if (!fs.existsSync(ASSETS_CSV)) { console.error(`Missing ${ASSETS_CSV}`); process.exit(1); }
if (!fs.existsSync(WOS_CSV))    { console.error(`Missing ${WOS_CSV}`);    process.exit(1); }

// ── CSV parsing ─────────────────────────────────────────────────────
// Roll our own because the work-orders CSV has embedded newlines
// inside quoted descriptions and we want a single dependency-free
// script. State machine handles quoted fields, escaped quotes
// (""), and the newline-inside-quotes case.
function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0]?.trim() !== ""));
}

// ── Read CSVs ───────────────────────────────────────────────────────
const assetsRows = parseCsv(fs.readFileSync(ASSETS_CSV, "utf8"));
const wosRows    = parseCsv(fs.readFileSync(WOS_CSV,    "utf8"));

// Headers in row 0.
const assetsHeader = assetsRows[0]!;
const wosHeader    = wosRows[0]!;
const assetCol = (name: string) => assetsHeader.indexOf(name);
const woCol    = (name: string) => wosHeader.indexOf(name);

// Build old-asset lookup: { uuid → { type, unit } }.
interface OldAssetEntry { type: string; unit: string; label: string }
const oldAssets = new Map<string, OldAssetEntry>();
for (let i = 1; i < assetsRows.length; i++) {
  const r = assetsRows[i]!;
  oldAssets.set(r[assetCol("id")]!, {
    type:  r[assetCol("type")]  ?? "",
    unit:  r[assetCol("unit")]  ?? "",
    label: r[assetCol("label")] ?? "",
  });
}

// ── Connect to new system ───────────────────────────────────────────
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

(async () => {
  console.log(`[import] org_id=${ORG_ID} dry_run=${dryRun}`);

  // Fetch new assets + trailers to build the resolution map.
  const newAssetsRes = await sb
    .from("assets")
    .select("id, unit, name")
    .eq("org_id", ORG_ID);
  if (newAssetsRes.error) { console.error("Failed to fetch assets:", newAssetsRes.error); process.exit(1); }
  const newAssetsByUnit = new Map<string, number>();
  for (const a of (newAssetsRes.data ?? []) as Array<{ id: number; unit: string | null }>) {
    if (a.unit) newAssetsByUnit.set(a.unit, a.id);
  }
  console.log(`[import] new assets loaded: ${newAssetsByUnit.size}`);

  const newTrailersRes = await sb
    .from("trailers")
    .select("id, trailer_number, name")
    .eq("org_id", ORG_ID);
  if (newTrailersRes.error) { console.error("Failed to fetch trailers:", newTrailersRes.error); process.exit(1); }
  const newTrailersByNumber = new Map<string, number>();
  for (const t of (newTrailersRes.data ?? []) as Array<{ id: number; trailer_number: string | null }>) {
    if (t.trailer_number) newTrailersByNumber.set(t.trailer_number, t.id);
  }
  console.log(`[import] new trailers loaded: ${newTrailersByNumber.size}`);

  // Fetch already-imported rows so re-runs don't double up. We tag
  // imported rows by appending "[migrated-from <old-uuid>]" to their
  // description; pre-load every tag the org already has so we can
  // skip dupes in O(1).
  const existingRes = await sb
    .from("maintenance_action_items")
    .select("id, description")
    .eq("org_id", ORG_ID)
    .like("description", "%[migrated-from %");
  if (existingRes.error) { console.error("Failed to fetch existing:", existingRes.error); process.exit(1); }
  const alreadyImported = new Set<string>();
  const TAG_RE = /\[migrated-from ([0-9a-f-]+)\]/i;
  for (const r of (existingRes.data ?? []) as Array<{ description: string | null }>) {
    const m = TAG_RE.exec(r.description ?? "");
    if (m) alreadyImported.add(m[1]!);
  }
  console.log(`[import] previously imported: ${alreadyImported.size}`);

  // ── Build insert payloads ─────────────────────────────────────────
  type InsertRow = {
    org_id:         string;
    asset_id:       number | null;
    trailer_id:     number | null;
    title:          string;
    description:    string | null;
    category:       string;
    priority:       string;
    status:         string;
    out_of_service: boolean;
    completed_at:   string | null;
    created_by:     string;
    created_at:     string;
    updated_at:     string;
  };

  const VALID_CATEGORIES = new Set(["repair", "pm", "inspection", "other"]);
  const VALID_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
  const VALID_STATUSES   = new Set(["open", "in_progress", "done"]);

  const payloads: InsertRow[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let mappedTruck = 0, mappedTrailer = 0, unmapped = 0;

  for (let i = 1; i < wosRows.length; i++) {
    const r = wosRows[i]!;
    const oldId       = r[woCol("id")]              ?? "";
    const oldAssetId  = r[woCol("asset_id")]        ?? "";
    const title       = (r[woCol("title")]          ?? "").trim();
    const description = (r[woCol("description")]    ?? "").trim();
    const category    = (r[woCol("category")]       ?? "").toLowerCase();
    const priority    = (r[woCol("priority")]       ?? "").toLowerCase();
    const status      = (r[woCol("status")]         ?? "").toLowerCase();
    const oosRaw      = (r[woCol("out_of_service")] ?? "").toLowerCase();
    const completedAt = r[woCol("completed_at")]    ?? "";
    const createdAt   = r[woCol("created_at")]      ?? "";
    const updatedAt   = r[woCol("updated_at")]      ?? "";

    if (!oldId)   { skipped.push({ id: "(no id)", reason: "missing id" });   continue; }
    if (!title)   { skipped.push({ id: oldId, reason: "missing title" });    continue; }
    if (alreadyImported.has(oldId)) { skipped.push({ id: oldId, reason: "already imported" }); continue; }

    // Resolve old asset → new asset OR trailer.
    let assetId:   number | null = null;
    let trailerId: number | null = null;
    if (oldAssetId) {
      const oa = oldAssets.get(oldAssetId);
      if (oa) {
        if (oa.type === "truck")   { assetId   = newAssetsByUnit.get(oa.unit)      ?? null; if (assetId   != null) mappedTruck++;   }
        if (oa.type === "trailer") { trailerId = newTrailersByNumber.get(oa.unit)  ?? null; if (trailerId != null) mappedTrailer++; }
      }
      if (assetId == null && trailerId == null) {
        unmapped++;
        // Still allow the row to land (both null); the dispatcher can
        // assign equipment later from the UI rather than fix it
        // pre-import.
      }
    }

    payloads.push({
      org_id:         ORG_ID,
      asset_id:       assetId,
      trailer_id:     trailerId,
      title,
      description:    appendMigrationTag(description, oldId),
      category:       VALID_CATEGORIES.has(category) ? category : "repair",
      priority:       VALID_PRIORITIES.has(priority) ? priority : "normal",
      status:         VALID_STATUSES.has(status)     ? status   : "open",
      out_of_service: oosRaw === "true",
      completed_at:   (status === "done" && completedAt) ? completedAt : null,
      created_by:     "imported",
      created_at:     createdAt || new Date().toISOString(),
      updated_at:     updatedAt || createdAt || new Date().toISOString(),
    });
  }

  console.log("");
  console.log(`[import] summary`);
  console.log(`  total source rows:     ${wosRows.length - 1}`);
  console.log(`  to insert:             ${payloads.length}`);
  console.log(`    mapped to truck:     ${mappedTruck}`);
  console.log(`    mapped to trailer:   ${mappedTrailer}`);
  console.log(`    unmapped (still in): ${unmapped}`);
  console.log(`  skipped:               ${skipped.length}`);
  for (const s of skipped) console.log(`    skip ${s.id}: ${s.reason}`);
  console.log("");

  if (dryRun) {
    console.log("[import] DRY RUN — no inserts. Re-run without --dry-run to commit.");
    process.exit(0);
  }

  // Batch insert. 85 rows fits in one round-trip; chunk anyway for
  // anyone with thousands.
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < payloads.length; i += CHUNK) {
    const slice = payloads.slice(i, i + CHUNK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (sb as any).from("maintenance_action_items").insert(slice).select("id");
    if (res.error) {
      console.error(`[import] insert batch ${i}-${i + slice.length} failed:`, res.error);
      process.exit(1);
    }
    inserted += slice.length;
    console.log(`[import] inserted ${inserted}/${payloads.length}`);
  }

  console.log(`[import] done. ${inserted} rows imported.`);
  console.log(`[import] tip: clean migration tags later with`);
  console.log(`  UPDATE maintenance_action_items`);
  console.log(`  SET description = trim(regexp_replace(description, '\\s*\\[migrated-from [0-9a-f-]+\\]\\s*$', ''))`);
  console.log(`  WHERE org_id = '${ORG_ID}' AND description LIKE '%[migrated-from %';`);
})().catch(err => {
  console.error("[import] fatal:", err);
  process.exit(1);
});

/** Append the old WO's UUID as a comment so re-runs can dedupe.
 *  Cleaned out via the UPDATE statement printed at the end. */
function appendMigrationTag(description: string, oldId: string): string {
  const tag = `[migrated-from ${oldId}]`;
  return description ? `${description}\n\n${tag}` : tag;
}
