/**
 * N-leg relay helpers for the driver app.
 *
 * A relay load is N events (legs) sharing one load_id, ordered by
 * legIndex (0-based). EVERY leg carries the FULL merged stop list;
 * handoff stops are the leg boundaries — boundary i (0-based, in
 * sequence order) sits between leg i and leg i+1. Leg i's stop window
 * runs from boundary i-1 (or the first stop) through boundary i (or the
 * last stop), with both boundary stops included.
 *
 * A boundary is EITHER a dedicated `type:'relay'` marker (a bare
 * trailer-drop point) OR a real stop flagged `isHandoff` (e.g. leg 1
 * delivers in Hurricane and hands off right there). Always ask
 * `isHandoffStop()` — never test `type === 'relay'` yourself.
 *
 * Handoff direction, relative to MY leg:
 *   boundary legIndex-1 → my INBOUND handoff (previous driver brings the
 *                         trailer to me; I pick up here → handoff pickup)
 *   boundary legIndex   → my OUTBOUND handoff (I drop for the next
 *                         driver → handoff drop)
 * `handoffTimesOf()` normalizes where those two times live (apptStart /
 * apptEnd on relay points, handoffDropAt / handoffPickupAt elsewhere).
 */
import type { Load, Stop } from "./types";
import {
  legRoleName, legShortLabel,
  isHandoffStop, handoffIndexes, stopsForLeg,
} from "@fleetcal/types";

export type HandoffDirection = "inbound" | "outbound";

export interface LegPosition {
  legIndex: number;
  legCount: number;
}

/**
 * Resolve this leg's position within its load. Returns null for
 * non-relay loads. legCount comes from the API when present; otherwise
 * it's derived from the merged stop list (handoff stops + 1 = legs),
 * falling back to 2 when only partnerStops hints at a second leg
 * (legacy 2-leg payloads).
 */
export function legPositionOf(
  load: Pick<Load, "relayRole" | "legIndex" | "legCount" | "stops" | "partnerStops">,
): LegPosition | null {
  if (!load.relayRole) return null;
  const markerCount = handoffIndexes(load.stops ?? []).length;
  const legCount =
    load.legCount
    ?? (markerCount > 0 ? markerCount + 1 : (load.partnerStops?.length ? 2 : 2));
  // legIndex should always be set server-side; the role-based fallback
  // only matters for stale cached payloads (2-leg era).
  const rawIndex =
    load.legIndex
    ?? (load.relayRole === "pickup" ? 0 : load.relayRole === "delivery" ? legCount - 1 : 1);
  const legIndex = Math.min(Math.max(rawIndex, 0), legCount - 1);
  return { legIndex, legCount };
}

export interface LegStopWindow {
  /** Stops on earlier legs (before my inbound boundary). */
  before: Stop[];
  /** My leg's window — boundary handoff stops included. */
  mine: Stop[];
  /** Stops on later legs (after my outbound boundary). */
  after: Stop[];
  /** Array index (into the merged stops) of my inbound handoff; null on the first leg. */
  inboundMarkerIdx: number | null;
  /** Array index of my outbound handoff; null on the final leg. */
  outboundMarkerIdx: number | null;
}

/**
 * Slice the FULL merged stop list into before / mine / after for leg i.
 * `mine` delegates to the shared `stopsForLeg` so both apps agree on the
 * window; the marker indices are what the driver UI additionally needs to
 * know WHICH end of the window is a handoff.
 */
export function splitStopsForLeg(stops: Stop[], legIndex: number): LegStopWindow {
  const markerIdxs = handoffIndexes(stops);
  const inboundMarkerIdx =
    legIndex - 1 >= 0 && legIndex - 1 < markerIdxs.length ? markerIdxs[legIndex - 1] : null;
  const outboundMarkerIdx =
    legIndex >= 0 && legIndex < markerIdxs.length ? markerIdxs[legIndex] : null;
  const startIdx = inboundMarkerIdx ?? 0;
  const endIdx   = outboundMarkerIdx ?? stops.length - 1;
  return {
    before: stops.slice(0, startIdx),
    mine:   stopsForLeg(stops, legIndex),
    after:  stops.slice(endIdx + 1),
    inboundMarkerIdx,
    outboundMarkerIdx,
  };
}

/**
 * Which of MY handoffs a stop in my window is, if any.
 *   inbound  → first stop of the window when it's the boundary I start at
 *   outbound → last stop of the window when it's the boundary I end at
 * A boundary sitting on a REAL stop counts exactly like a relay point —
 * the stop still renders as its own pickup/delivery, it just also gets
 * the handoff treatment.
 */
export function handoffDirectionFor(
  win: LegStopWindow,
  stop: Stop,
): HandoffDirection | undefined {
  if (!isHandoffStop(stop)) return undefined;
  if (win.inboundMarkerIdx != null && win.mine[0]?.id === stop.id) return "inbound";
  if (win.outboundMarkerIdx != null && win.mine[win.mine.length - 1]?.id === stop.id) return "outbound";
  return undefined;
}

/**
 * Handoff ordinals (marker i sits between leg i and i+1) for MY leg.
 *   inbound  = legIndex - 1 (undefined on the first leg)
 *   outbound = legIndex     (undefined on the final leg)
 */
export function myHandoffOrdinals(pos: LegPosition): {
  inbound?: number;
  outbound?: number;
} {
  return {
    inbound:  pos.legIndex > 0 ? pos.legIndex - 1 : undefined,
    outbound: pos.legIndex < pos.legCount - 1 ? pos.legIndex : undefined,
  };
}

/** "LEG 2/3 · TRANSFER" — chip text shared by the schedule + load cards. */
export function relayChipLabel(pos: LegPosition): string {
  const short = legShortLabel(pos.legIndex, pos.legCount);
  const role  = legRoleName(pos.legIndex, pos.legCount);
  if (!short) return "";
  return role ? `${short.toUpperCase()} · ${role.toUpperCase()}` : short.toUpperCase();
}
