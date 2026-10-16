/**
 * Runs the movement linker over a date range and SAVES the result
 * (movement_links + leg_actuals) — the same writer the 6-hourly job uses.
 * Re-runnable; manual links are never touched. --dry-run counts what would
 * change without writing. See docs/movement-linking.md.
 *
 *   railway run --service @fleetcal/api npx tsx apps/api/scripts/movement-link-backfill.ts <orgId> <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run]
 */

import { runMovementLinking } from "../src/lib/movementLinkJob.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [orgId, from, to] = args.filter((a) => a !== "--dry-run");
if (!orgId || !from || !to) {
  console.error("usage: movement-link-backfill.ts <orgId> <from> <to> [--dry-run]");
  process.exit(1);
}

const r = await runMovementLinking(orgId, { from, to, dryRun });
console.log(JSON.stringify({ dryRun, ...r }, null, 1));
