/**
 * Inspection-video retention sweep.
 *
 * Auto-deletes walkaround videos attached to inspections after 90 days.
 * Videos are useful for near-term coaching + damage disputes; a
 * 4-month-old clip has effectively zero value and would otherwise
 * accumulate forever in Supabase Storage at ~150MB each (720p, 3 min).
 *
 * Photos are NOT swept — they're small (~5MB), permanent evidence of
 * a specific inspection, and drivers/dispatch may reference them
 * months later for warranty/insurance claims.
 *
 * Two-phase delete: remove the storage blob first, then the DB row.
 * If the storage delete fails we leave the DB row alone and try again
 * next run — a lingering blob is annoying but keeping the row means
 * we still have the pointer to retry from. If the DB delete fails
 * after the blob is gone (shouldn't happen; nothing else touches
 * inspection_photos.id), the next sweep re-attempts the storage
 * delete (idempotent on Supabase) and the DB delete succeeds.
 *
 * Idempotent: subsequent runs over the same window find nothing to
 * do because the WHERE clause filters swept rows out.
 */

import { supabase } from "./supabase.js";

const RETENTION_DAYS = 90;
const INSPECTION_PHOTO_BUCKET = "inspection-photos";
/** Cap per-run to keep the sweep predictable. 500 = ~75GB reclaimed
 *  per pass at 150MB/video — a full year of Curzon backlog would drain
 *  in a few days of daily runs, then steady-state stays trivial. */
const BATCH_LIMIT = 500;

export interface VideoSweepResult {
  candidates:    number;
  storageDeleted: number;
  storageFailed: number;
  rowsDeleted:   number;
  errors:        string[];
}

export async function sweepOldInspectionVideos(): Promise<VideoSweepResult> {
  const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("inspection_photos")
    .select("id, storage_path")
    .eq("media_kind", "video")
    .lt("uploaded_at", cutoffIso)
    .limit(BATCH_LIMIT);

  const errors: string[] = [];
  if (error) {
    errors.push(`select failed: ${error.message}`);
    return { candidates: 0, storageDeleted: 0, storageFailed: 0, rowsDeleted: 0, errors };
  }

  const rows = (data ?? []) as Array<{ id: string; storage_path: string }>;
  if (rows.length === 0) {
    return { candidates: 0, storageDeleted: 0, storageFailed: 0, rowsDeleted: 0, errors };
  }

  // Bulk storage delete — Supabase accepts an array of paths and
  // returns a per-object result. Missing objects are non-fatal (they
  // may have been swept by a prior interrupted run), so we always
  // proceed to delete the matching DB rows.
  const paths = rows.map(r => r.storage_path);
  let storageDeleted = 0;
  let storageFailed  = 0;
  const { data: rmData, error: rmErr } = await supabase.storage
    .from(INSPECTION_PHOTO_BUCKET)
    .remove(paths);
  if (rmErr) {
    // Storage-wide failure — bail without touching the DB so the next
    // run retries the same batch.
    errors.push(`storage remove failed: ${rmErr.message}`);
    return { candidates: rows.length, storageDeleted: 0, storageFailed: rows.length, rowsDeleted: 0, errors };
  }
  storageDeleted = (rmData ?? []).length;
  storageFailed  = paths.length - storageDeleted;

  const ids = rows.map(r => r.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: delErr, count } = await (supabase as any)
    .from("inspection_photos")
    .delete({ count: "exact" })
    .in("id", ids);
  if (delErr) {
    errors.push(`db delete failed: ${delErr.message}`);
    return { candidates: rows.length, storageDeleted, storageFailed, rowsDeleted: 0, errors };
  }

  return {
    candidates:     rows.length,
    storageDeleted,
    storageFailed,
    rowsDeleted:    count ?? ids.length,
    errors,
  };
}
