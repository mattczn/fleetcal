/**
 * Periodic movement linking: for every org with Motive connected, re-links
 * the last MOVEMENT_LINK_WINDOW_DAYS (default 10) days of truck GPS against
 * the calendar and refreshes leg_actuals. See lib/movementLinkJob.ts and
 * docs/movement-linking.md.
 *
 * Why a rolling window, not just yesterday: OTR legs span days, the
 * calendar gets corrected after the fact (a truck swap entered on Monday
 * for last Thursday), and Motive edits recent driving periods. Re-running
 * is cheap and only writes what changed; links someone set by hand are
 * never touched.
 *
 * No-ops until the leg_actuals migration has been run. Scheduled in
 * apps/api/src/index.ts.
 */

import { supabase as supabaseTyped } from "../lib/supabase.js";
import { runMovementLinking, type LinkRunResult } from "../lib/movementLinkJob.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const WINDOW_DAYS = Number(process.env.MOVEMENT_LINK_WINDOW_DAYS ?? 10);

const utcDay = (offsetDays: number) =>
  new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

export async function runMovementLinkSweep(): Promise<LinkRunResult[]> {
  const { data: orgs, error } = await supabase
    .from("org_settings")
    .select("org_id")
    .not("motive_api_key", "is", null);
  if (error) throw new Error(`movement-link orgs lookup: ${error.message}`);

  const results: LinkRunResult[] = [];
  for (const { org_id } of (orgs ?? []) as Array<{ org_id: string }>) {
    results.push(await runMovementLinking(org_id, { from: utcDay(WINDOW_DAYS), to: utcDay(0) }));
  }
  return results;
}
