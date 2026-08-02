/**
 * Shared relay-leg revenue proration for report aggregations.
 *
 * A relay load is ONE revenue load (one `loads` row, one price) hauled
 * by N drivers as N `events` rows sharing `load_id`. Any rollup that
 * adds the load's price once per event triples a 3-leg load's revenue.
 * Every consumer must weight each leg by its share of the haul:
 *
 *   share = thisLeg.loaded_miles / Σ(every leg's loaded_miles)
 *
 * Falls back to an even 1/N split when the load has NO usable miles on
 * any leg — better than crediting the whole load to one truck, and
 * fair to the drivers who hauled the rest of it. Note the fallback is
 * all-or-nothing by design: if even one leg has miles, the legs without
 * miles score 0 rather than dragging the whole load onto an even split.
 * That mirrors the web's `relayLegShareN` exactly, so the dashboard and
 * the server agree to the cent.
 *
 * Shares always sum to 1.0 across a load's legs, which is what makes
 * these maps safe to use in fleet-wide totals as well as per-truck ones.
 *
 * Used by:
 *   - /v1/fleet/performance    (per-asset revenue + leaderboards)
 *   - /v1/timeline (day + week summary)
 *
 * Legs are fetched by `load_id` WITHOUT a date filter on purpose: a
 * relay's other legs routinely fall outside the caller's window (that's
 * the whole point of a relay), and omitting them would shrink the
 * denominator and over-credit whichever leg happened to be in range.
 */

import { supabase } from "./supabase.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

/** Minimum shape a caller's event rows need for share resolution. */
export interface RelayShareCandidate {
  id:         string;
  load_id:    string | null;
  relay_role: string | null;
}

/**
 * Build an eventId → share (0..1) map for every relay leg among
 * `events`. Non-relay events are absent from the map — callers should
 * read it as `shareByEventId.get(e.id) ?? 1`, so a single-event load
 * keeps its full price with no special-casing.
 *
 * Returns an empty map (never throws) when the leg fetch fails; the
 * caller then degrades to un-prorated revenue, which is wrong but not
 * an outage. The error is logged so it surfaces in Railway.
 */
export async function buildRelayShareMap(
  orgId:  string,
  events: RelayShareCandidate[],
): Promise<Map<string, number>> {
  const shareByEventId = new Map<string, number>();

  const relayLoadIds = [...new Set(
    events.filter((e) => e.relay_role != null)
          .map((e) => e.load_id)
          .filter((x): x is string => x != null),
  )];
  if (relayLoadIds.length === 0) return shareByEventId;

  const { data, error } = await sb
    .from("events")
    .select("id, load_id, loaded_miles")
    .eq("org_id", orgId)
    .in("load_id", relayLoadIds)
    .is("deleted_at", null);
  if (error) {
    console.error("[relayShare] leg fetch failed:", error);
    return shareByEventId;
  }

  const legsByLoad = new Map<string, Array<{ id: string; loaded_miles: number | null }>>();
  for (const r of (data ?? []) as Array<{ id: string; load_id: string; loaded_miles: number | null }>) {
    if (!legsByLoad.has(r.load_id)) legsByLoad.set(r.load_id, []);
    legsByLoad.get(r.load_id)!.push({ id: r.id, loaded_miles: r.loaded_miles });
  }

  for (const [, legs] of legsByLoad) {
    // A "relay" that resolves to one live leg (the others were removed
    // or soft-deleted) is just a normal load — leaving it out of the
    // map gives it share=1 via the caller's ?? 1 default.
    if (legs.length < 2) continue;
    const total = legs.reduce((sum, l) => sum + (l.loaded_miles ?? 0), 0);
    for (const leg of legs) {
      shareByEventId.set(
        leg.id,
        total > 0 ? (leg.loaded_miles ?? 0) / total : 1 / legs.length,
      );
    }
  }

  return shareByEventId;
}
