/**
 * Periodic Ramp Developer API sync. Mirrors mudflapSyncSweep exactly:
 * rolling 7-day window (idempotent), single-org default (Curzon), env-
 * gated no-op when credentials are absent. Runs on a 30-minute interval
 * from apps/api/src/index.ts.
 *
 * Window is wider than Mudflap's (7 vs 3 days) because Ramp posts +
 * settlement lag on receipts + memos can span several days as the team
 * updates memos after the swipe.
 */

import { syncRamp, type RampSyncResult } from "../lib/rampSync.js";

const DEFAULT_ORG_ID = "org_3Ck09w6LuEjiX4WgxJEPyiyjuXN"; // Curzon Trucking prod
const WINDOW_DAYS = Number(process.env.RAMP_SYNC_WINDOW_DAYS ?? 7);

export interface RampSyncSweepResult {
  /** True when the sweep no-opped (no Ramp credentials configured). */
  skipped: boolean;
  reason?: string;
  orgId?:  string;
  from?:   string;
  to?:     string;
  result?: RampSyncResult;
}

function utcDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export async function runRampSyncSweep(): Promise<RampSyncSweepResult> {
  if (!process.env.RAMP_CLIENT_ID || !process.env.RAMP_CLIENT_SECRET) {
    return { skipped: true, reason: "no_credentials" };
  }
  const orgId = process.env.RAMP_SYNC_ORG_ID || DEFAULT_ORG_ID;
  const to    = utcDay(0);
  const from  = utcDay(WINDOW_DAYS);
  const result = await syncRamp(orgId, from, to);
  return { skipped: false, orgId, from, to, result };
}
