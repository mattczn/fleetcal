/**
 * Server-side audit-log appenders.
 *
 * Mirrors the client-side LoadAuditEntry pattern in
 * apps/web/components/calendar/EventModal.tsx but writes from inside
 * route handlers — used wherever a mutation happens server-side
 * without a corresponding client-built entry (document operations,
 * status changes via dispatcher PATCH, billing transitions in
 * closeout/invoices, etc.).
 *
 * Two columns exist:
 *   • events.audit_log  — per-leg entries (driver actions, per-leg
 *                          dispatcher edits, document uploads keyed
 *                          to a specific event)
 *   • loads.audit_log   — load-level entries (broker, customer, price,
 *                          billing status — things that don't pin to
 *                          a single leg)
 *
 * The read path in routes/events.ts merges both before returning to
 * the client, so it doesn't matter for display which table you write
 * to — but it does matter for correctness. Use appendEventAudit for
 * leg-scoped facts and appendLoadAudit for load-level facts.
 */

import type { LoadAuditEntry } from "@fleetcal/types";
import { supabase } from "./supabase.js";

/** Window for dedup. If the candidate matches an existing entry semantically
 *  (everything except changedAt) AND the existing entry's changedAt is within
 *  this many ms of the candidate's, treat as a duplicate and skip the write.
 *
 *  Why this exists: clients fire status/document/trailer updates from several
 *  surfaces (driver app retries, realtime echo loops re-applying writes,
 *  multi-tab double-PATCH, dispatcher web app reacting to its own realtime
 *  update, etc.). A 60s window catches every realistic burst without
 *  swallowing legitimate "changed it back" sequences minutes later. */
const DEDUP_WINDOW_MS = 60_000;

/** Compare two audit entries by their semantic content, ignoring changedAt.
 *  Stringify is the cheapest path to a deep compare here — entries are small
 *  flat objects with a handful of strings + small nested shapes. */
function semanticallyEqual(a: LoadAuditEntry, b: LoadAuditEntry): boolean {
  const stripTime = (e: LoadAuditEntry) => {
    // Pull `changedAt` out; everything else must match exactly.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { changedAt, ...rest } = e as LoadAuditEntry & { changedAt?: string };
    return JSON.stringify(rest);
  };
  return stripTime(a) === stripTime(b);
}

/** True if `entry` duplicates anything in `existing` within DEDUP_WINDOW_MS.
 *  Scans last 10 entries — bursts cluster at the end, and we don't want to
 *  walk a multi-year audit_log on every append. */
export function isDuplicateAuditEntry(
  existing: LoadAuditEntry[],
  entry:    LoadAuditEntry,
): boolean {
  const candidateMs = Date.parse(entry.changedAt ?? "");
  if (!Number.isFinite(candidateMs)) return false;
  // Tail scan — recent entries first.
  const tail = existing.slice(-10);
  for (let i = tail.length - 1; i >= 0; i--) {
    const prev = tail[i];
    const prevMs = Date.parse(prev.changedAt ?? "");
    if (!Number.isFinite(prevMs)) continue;
    if (Math.abs(candidateMs - prevMs) > DEDUP_WINDOW_MS) continue;
    if (semanticallyEqual(prev, entry)) return true;
  }
  return false;
}

/** Append a single entry to events.audit_log for one specific event id.
 *  Skips the write when the entry duplicates a recent existing one (see
 *  DEDUP_WINDOW_MS). The "load picked up 3 times in 1 second" pattern is
 *  caught here. */
export async function appendEventAudit(
  eventId: string,
  orgId:   string,
  entry:   LoadAuditEntry,
): Promise<void> {
  const { data, error } = await supabase
    .from("events")
    .select("audit_log")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) { console.error("[appendEventAudit] read:", error); return; }
  const existing = ((data as { audit_log: LoadAuditEntry[] | null } | null)?.audit_log) ?? [];
  if (isDuplicateAuditEntry(existing, entry)) {
    // Silently drop. Telemetry would be nice here if this ever needs
    // investigating, but for now keep it quiet — a 100% expected debounce.
    return;
  }
  const next = [...existing, entry];
  const { error: writeErr } = await supabase
    .from("events")
    .update({ audit_log: next as never })
    .eq("id", eventId)
    .eq("org_id", orgId);
  if (writeErr) console.error("[appendEventAudit] write:", writeErr);
}

/** Append a single entry to loads.audit_log for one specific load id.
 *  Dedup logic mirrors appendEventAudit. */
export async function appendLoadAudit(
  loadId: string,
  orgId:  string,
  entry:  LoadAuditEntry,
): Promise<void> {
  const { data, error } = await supabase
    .from("loads")
    .select("audit_log")
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) { console.error("[appendLoadAudit] read:", error); return; }
  const existing = ((data as { audit_log: LoadAuditEntry[] | null } | null)?.audit_log) ?? [];
  if (isDuplicateAuditEntry(existing, entry)) return;
  const next = [...existing, entry];
  const { error: writeErr } = await supabase
    .from("loads")
    .update({ audit_log: next as never })
    .eq("id", loadId)
    .eq("org_id", orgId);
  if (writeErr) console.error("[appendLoadAudit] write:", writeErr);
}
