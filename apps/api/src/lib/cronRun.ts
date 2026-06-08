/**
 * Tracker for in-process cron jobs. Wraps a job function so each
 * invocation lands one row in `cron_runs` with started_at,
 * finished_at, duration_ms, success/error, and an optional
 * job-specific metric bag.
 *
 * Usage:
 *
 *   await trackCronRun('confirm-reminders', async () => {
 *     const r = await runConfirmReminders();
 *     return {
 *       meta: {
 *         evening:   r.evening,
 *         prePickup: r.prePickup,
 *         missingPod: r.missingPod,
 *       },
 *     };
 *   });
 *
 * Failure semantics: a thrown error is logged + persisted as a
 * failed run, then re-thrown so the existing try/catch in
 * apps/api/src/index.ts can log to console as before. The cron
 * row exists either way.
 *
 * Writes are best-effort — a failed Supabase insert logs to
 * console but never blocks the cron's actual work. The cron
 * already ran; missing one heartbeat row is recoverable.
 */

import { supabase as typedSupabase } from "./supabase.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = typedSupabase as any;

export interface CronRunOk {
  /** Optional JSON metric payload for the meta column. */
  meta?: Record<string, unknown>;
}

const ERROR_MESSAGE_MAX = 500;

export async function trackCronRun(
  jobName: string,
  fn: () => Promise<CronRunOk | void>,
): Promise<void> {
  const startedAt = new Date();
  let success: boolean = false;
  let errorCode:   string | null = null;
  let errorMsg:    string | null = null;
  let meta:        Record<string, unknown> | undefined;

  try {
    const result = await fn();
    success = true;
    if (result && typeof result === "object" && "meta" in result) {
      meta = result.meta;
    }
  } catch (err) {
    success = false;
    errorCode = (err as { code?: string })?.code ?? null;
    const raw = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    errorMsg = raw.length > ERROR_MESSAGE_MAX ? raw.slice(0, ERROR_MESSAGE_MAX) + "…" : raw;
    // Re-throw AFTER we've captured the failure shape so the
    // existing try/catch in apps/api/src/index.ts still logs to
    // console. The persistence below runs in the finally-like
    // path before the throw because finally can't await cleanly.
    void persist({ jobName, startedAt, success, errorCode, errorMsg, meta });
    throw err;
  }

  void persist({ jobName, startedAt, success, errorCode, errorMsg, meta });
}

async function persist(args: {
  jobName:     string;
  startedAt:   Date;
  success:     boolean;
  errorCode:   string | null;
  errorMsg:    string | null;
  meta?:       Record<string, unknown>;
}): Promise<void> {
  try {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - args.startedAt.getTime();
    const { error } = await supabase.from("cron_runs").insert({
      job_name:      args.jobName,
      started_at:    args.startedAt.toISOString(),
      finished_at:   finishedAt.toISOString(),
      duration_ms:   durationMs,
      success:       args.success,
      error_code:    args.errorCode,
      error_message: args.errorMsg,
      meta:          args.meta ?? null,
    });
    if (error) {
      console.warn(`[cronRun] persist failed for ${args.jobName}: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[cronRun] persist threw for ${args.jobName}:`, err);
  }
}
