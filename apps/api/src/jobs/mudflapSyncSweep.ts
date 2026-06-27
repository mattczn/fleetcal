/**
 * Periodic Mudflap Carriers API sync.
 *
 * Pulls the last MUDFLAP_SYNC_WINDOW_DAYS (default 3) days of card
 * transactions from the Mudflap Carriers API into fuel_transactions —
 * the automated equivalent of the manual "Sync Mudflap" button on the
 * Equipment page (POST /v1/fuel-transactions/mudflap-sync). The same
 * syncMudflapCarriers() entry point backs both, so card-side ingest,
 * asset matching, and the inline driver-report matcher all run
 * identically whether the pull is triggered by hand or by this cron.
 *
 * Rolling window, not just "today": Mudflap can deliver receipts late
 * or backdated, and the ingest is idempotent (a duplicate
 * provider_transaction_id hits the unique constraint and is counted as
 * a duplicate, not an error). Re-pulling a few days every run is cheap
 * and self-heals any gap left by a missed or failed run.
 *
 * Single-org for now: the Carriers API token is a single global
 * MUDFLAP_CARRIERS_TOKEN (Curzon's), so the sweep runs for one org
 * (MUDFLAP_SYNC_ORG_ID, Curzon prod by default) and no-ops cleanly when
 * the token isn't configured (staging / other deploys). When per-org
 * tokens land this becomes an enumerate-orgs-with-a-key loop, mirroring
 * motiveIngest.syncIncrementalAllOrgs.
 *
 * Scheduled on a 30-minute interval in apps/api/src/index.ts.
 */

import {
  syncMudflapCarriers,
  type MudflapSyncResult,
} from "../lib/mudflapCarriersSync.js";

const DEFAULT_ORG_ID = "org_3Ck09w6LuEjiX4WgxJEPyiyjuXN"; // Curzon Trucking prod
const WINDOW_DAYS = Number(process.env.MUDFLAP_SYNC_WINDOW_DAYS ?? 3);

export interface MudflapSyncSweepResult {
  /** True when the sweep no-opped (no Carriers API token configured). */
  skipped: boolean;
  reason?: string;
  orgId?:  string;
  from?:   string;
  to?:     string;
  result?: MudflapSyncResult;
}

/** UTC YYYY-MM-DD, `offsetDays` ago (0 = today). */
function utcDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export async function runMudflapSyncSweep(): Promise<MudflapSyncSweepResult> {
  // No global Carriers API token (staging / non-Curzon deploys): no-op
  // cleanly instead of letting syncMudflapCarriers throw every interval,
  // which would log an error and persist a failed cron_runs row each tick.
  if (!process.env.MUDFLAP_CARRIERS_TOKEN) {
    return { skipped: true, reason: "no_token" };
  }

  const orgId = process.env.MUDFLAP_SYNC_ORG_ID || DEFAULT_ORG_ID;
  const to    = utcDay(0);
  const from  = utcDay(WINDOW_DAYS);

  const result = await syncMudflapCarriers(orgId, from, to);
  return { skipped: false, orgId, from, to, result };
}
