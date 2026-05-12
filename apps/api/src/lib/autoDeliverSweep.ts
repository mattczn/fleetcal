/**
 * Auto-deliver sweep.
 *
 * Drivers + dispatchers don't always remember to flip a load's status
 * to `delivered`. After the load's end time has passed by 24 hours,
 * we do it for them so downstream views (calendar color, closeout
 * status chip, audit log) reflect reality.
 *
 * Relay-aware: a relay load has two events sharing one load_id —
 * a pickup leg (ends at the handoff time) and a delivery leg (ends
 * at the actual delivery). We use the DELIVERY leg's end for the
 * 24h gate so a relay load doesn't get marked delivered when only
 * the handoff is past 24h. Both legs flip together so the load is
 * consistent.
 *
 * Skipped:
 *   - delivered  (already there)
 *   - cancelled  (intentional dead)
 *   - tonu       (intentional dead — driver showed but load was killed)
 *   - non_revenue events (no delivery to track)
 *   - deleted    (soft-deleted)
 *
 * Loads currently in `problem` status are still swept — a long-stale
 * problem still needs to land in closeout for dispatcher follow-up.
 *
 * The function is idempotent: subsequent runs over the same window
 * find nothing to do, since the status check filters them out.
 */

import { supabase } from "./supabase.js";

const GRACE_MS = 24 * 60 * 60 * 1000;

interface EventRow {
  id:         string;
  load_id:    string | null;
  status:     string;
  relay_role: string | null;
  end:        string;
  org_id:     string;
}

export interface AutoDeliverResult {
  swept:    number;
  loadIds:  string[];
  /** Per-leg event ids that were updated. Useful for cache busting
   *  and audit log writers. */
  eventIds: string[];
}

export async function sweepAutoDeliver(): Promise<AutoDeliverResult> {
  const nowMs    = Date.now();
  const cutoffMs = nowMs - GRACE_MS;

  // Pull every candidate event with a populated end time. We deliberately
  // don't gate on end < cutoff in the query — for relay loads we need
  // the delivery leg's end, which may belong to a different row than
  // the pickup leg we'd otherwise filter out.
  const { data, error } = await supabase
    .from("events")
    .select("id, load_id, status, relay_role, end, org_id")
    .eq("event_kind", "revenue")
    .is("deleted_at", null)
    .not("status", "in", "(delivered,cancelled,tonu)")
    .not("end", "is", null);

  if (error) {
    throw new Error(`[auto-deliver-sweep] events query failed: ${error.message}`);
  }
  const rows = (data ?? []) as EventRow[];
  if (rows.length === 0) return { swept: 0, loadIds: [], eventIds: [] };

  // Group by load_id. Standalone events (no load_id — shouldn't happen
  // for event_kind='revenue' post-2.5a, defensive) get their own end
  // used directly.
  const byLoad = new Map<string, EventRow[]>();
  const standalone: EventRow[] = [];
  for (const r of rows) {
    if (!r.load_id) { standalone.push(r); continue; }
    const arr = byLoad.get(r.load_id) ?? [];
    arr.push(r);
    byLoad.set(r.load_id, arr);
  }

  const eventIdsToFlip: string[] = [];
  const flippedLoadIds: string[] = [];

  for (const [loadId, legs] of byLoad) {
    // Pick the delivery-leg's end for relays; for single-leg loads
    // the lone row IS the delivery.
    const deliveryLeg = legs.find(l => l.relay_role === "delivery");
    const reference = deliveryLeg ?? legs[0];
    if (!reference) continue;
    const endMs = new Date(reference.end).getTime();
    if (!Number.isFinite(endMs)) continue;
    if (endMs > cutoffMs) continue; // still within grace window

    for (const leg of legs) eventIdsToFlip.push(leg.id);
    flippedLoadIds.push(loadId);
  }

  for (const e of standalone) {
    const endMs = new Date(e.end).getTime();
    if (!Number.isFinite(endMs)) continue;
    if (endMs > cutoffMs) continue;
    eventIdsToFlip.push(e.id);
  }

  if (eventIdsToFlip.length === 0) {
    return { swept: 0, loadIds: [], eventIds: [] };
  }

  // Batch update — events.status is the only column we change. The
  // audit_log lives on the loads table; if we want a trail entry for
  // the auto-flip, that's a follow-up (would need a per-load update
  // since audit_log is an array column).
  const { error: updErr } = await supabase
    .from("events")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ status: "delivered" } as any)
    .in("id", eventIdsToFlip);

  if (updErr) {
    throw new Error(`[auto-deliver-sweep] update failed: ${updErr.message}`);
  }

  console.log(
    `[auto-deliver-sweep] flipped ${eventIdsToFlip.length} event(s) across ${flippedLoadIds.length + standalone.length} load(s) to delivered`,
  );
  return {
    swept:    eventIdsToFlip.length,
    loadIds:  flippedLoadIds,
    eventIds: eventIdsToFlip,
  };
}
