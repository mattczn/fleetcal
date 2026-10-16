/**
 * The GPS trail behind one load, for its map: every Motive drive the
 * movement linker charged to any of the load's legs — deadhead into it,
 * the loaded run, the return to the overnight park after it — grouped
 * into runs and drawn along the roads through each drive's endpoints
 * (Motive only gives us where a drive started and ended, so a run is
 * routed through those points with Mapbox), plus where the truck sat
 * along the way. See docs/movement-linking.md.
 */

import type { LoadTrailParked, LoadTrailResponse, LoadTrailRole, LoadTrailSegment } from "@fleetcal/types";
import { env } from "./env.js";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { airMilesBetween } from "./airMiles.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const MIN_PARK_HOURS = 0.25;
const MAX_WAYPOINTS = 25; // Mapbox Directions limit

interface LinkRow { movement_id: string; role: string; loaded_event_id: string | null; from_event_id: string | null; to_event_id: string | null }
interface MoveRow {
  id: string; asset_id: number; start_time: string; end_time: string | null; miles: number | null; destination: string | null;
  origin_lat: number | null; origin_lon: number | null; destination_lat: number | null; destination_lon: number | null;
}

type Pt = { lat: number; lng: number };
const pt = (lat: number | null, lng: number | null): Pt | null =>
  lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng) };
const near = (a: Pt, b: Pt) => airMilesBetween({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }) < 0.2;

async function roadPath(points: Pt[]): Promise<{ path: Pt[]; snapped: boolean }> {
  if (points.length < 2 || !env.mapboxToken) return { path: points, snapped: false };
  // Keep the first and last; thin the middle to Mapbox's waypoint cap.
  let wps = points;
  if (wps.length > MAX_WAYPOINTS) {
    const step = (wps.length - 1) / (MAX_WAYPOINTS - 1);
    wps = Array.from({ length: MAX_WAYPOINTS }, (_, i) => points[Math.round(i * step)]);
  }
  try {
    const coords = wps.map((p) => `${p.lng},${p.lat}`).join(";");
    const res = await fetch(
      `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${env.mapboxToken}&geometries=geojson&overview=simplified&steps=false`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return { path: points, snapped: false };
    const json = (await res.json()) as { routes?: { geometry: { coordinates: [number, number][] } }[] };
    const line = json.routes?.[0]?.geometry.coordinates;
    return line?.length ? { path: line.map(([lng, lat]) => ({ lat, lng })), snapped: true } : { path: points, snapped: false };
  } catch {
    return { path: points, snapped: false };
  }
}

export class TrailNotFoundError extends Error {}

export async function loadTrail(orgId: string, eventId: string): Promise<LoadTrailResponse> {
  const { data: ev } = await supabase.from("events").select("id, load_id, event_kind").eq("org_id", orgId).eq("id", eventId).maybeSingle();
  if (!ev) throw new TrailNotFoundError("Calendar entry not found");

  // Every leg of the load (a relay's legs are different trucks).
  const legs: Array<{ id: string; event_kind: string }> = ev.load_id
    ? await fetchAllRows("trail legs", () => supabase.from("events").select("id, event_kind")
        .eq("org_id", orgId).eq("load_id", ev.load_id).is("deleted_at", null))
    : [{ id: ev.id, event_kind: ev.event_kind }];
  const legIds = legs.map((l) => l.id);
  const revenue = new Map(legs.map((l) => [l.id, l.event_kind === "revenue"]));

  const sel = "movement_id, role, loaded_event_id, from_event_id, to_event_id";
  const [loaded, inbound, outbound] = await Promise.all([
    fetchAllRows<LinkRow>("trail loaded", () => supabase.from("movement_links").select(sel).eq("org_id", orgId).is("superseded_at", null).in("loaded_event_id", legIds)),
    fetchAllRows<LinkRow>("trail inbound", () => supabase.from("movement_links").select(sel).eq("org_id", orgId).is("superseded_at", null).in("to_event_id", legIds)),
    fetchAllRows<LinkRow>("trail outbound", () => supabase.from("movement_links").select(sel).eq("org_id", orgId).is("superseded_at", null).in("from_event_id", legIds).is("to_event_id", null)),
  ]);

  // Role + leg for each linked drive. Dwell links are dock moves — they
  // show up as parked time, not as a line.
  const roleOf = new Map<string, { role: LoadTrailRole; leg: string }>();
  for (const l of loaded) {
    if (l.role !== "loaded" || !l.loaded_event_id) continue;
    roleOf.set(l.movement_id, { role: revenue.get(l.loaded_event_id) ? "loaded" : "non_revenue", leg: l.loaded_event_id });
  }
  for (const l of inbound) if (l.role === "transition" && l.to_event_id) roleOf.set(l.movement_id, { role: "deadhead", leg: l.to_event_id });
  for (const l of outbound) if (l.role === "transition" && l.from_event_id) roleOf.set(l.movement_id, { role: "return", leg: l.from_event_id });
  if (roleOf.size === 0) return { segments: [], parked: [] };

  const ids = [...roleOf.keys()];
  const moves: MoveRow[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    moves.push(...await fetchAllRows<MoveRow>("trail movements", () => supabase.from("movements")
      .select("id, asset_id, start_time, end_time, miles, destination, origin_lat, origin_lon, destination_lat, destination_lon")
      .eq("org_id", orgId).in("id", ids.slice(i, i + 150))));
  }
  moves.sort((a, b) => a.asset_id - b.asset_id || a.start_time.localeCompare(b.start_time));

  const assetIds = [...new Set(moves.map((m) => m.asset_id))];
  const assets = await fetchAllRows<{ id: number; name: string }>("trail assets", () =>
    supabase.from("assets").select("id, name").eq("org_id", orgId).in("id", assetIds));
  const truckName = new Map(assets.map((a) => [a.id, a.name]));

  // Runs: consecutive drives on the same truck with the same role + leg.
  type Run = { role: LoadTrailRole; leg: string; assetId: number; moves: MoveRow[] };
  const runs: Run[] = [];
  for (const m of moves) {
    const r = roleOf.get(m.id)!;
    const last = runs[runs.length - 1];
    if (last && last.role === r.role && last.leg === r.leg && last.assetId === m.asset_id) last.moves.push(m);
    else runs.push({ role: r.role, leg: r.leg, assetId: m.asset_id, moves: [m] });
  }

  const segments: LoadTrailSegment[] = await Promise.all(runs.map(async (run) => {
    const pts: Pt[] = [];
    for (const m of run.moves) {
      const a = pt(m.origin_lat, m.origin_lon);
      const b = pt(m.destination_lat, m.destination_lon);
      if (a && (!pts.length || !near(pts[pts.length - 1], a))) pts.push(a);
      if (b && (!pts.length || !near(pts[pts.length - 1], b))) pts.push(b);
    }
    const { path, snapped } = await roadPath(pts);
    const lastMove = run.moves[run.moves.length - 1];
    return {
      role: run.role,
      eventId: run.leg,
      assetId: run.assetId,
      truck: truckName.get(run.assetId) ?? null,
      start: run.moves[0].start_time,
      end: lastMove.end_time ?? lastMove.start_time,
      miles: Math.round(run.moves.reduce((s, m) => s + Number(m.miles ?? 0), 0) * 10) / 10,
      path,
      roadSnapped: snapped,
    };
  }));

  // Where the truck sat between linked drives (docks, fuel, rest).
  const parked: LoadTrailParked[] = [];
  for (let i = 0; i + 1 < moves.length; i++) {
    const a = moves[i];
    const b = moves[i + 1];
    if (a.asset_id !== b.asset_id || !a.end_time) continue;
    const hours = (Date.parse(b.start_time) - Date.parse(a.end_time)) / 3_600_000;
    const at = pt(a.destination_lat, a.destination_lon);
    if (!at || hours < MIN_PARK_HOURS || hours > 72) continue;
    parked.push({
      lat: at.lat, lng: at.lng, arrive: a.end_time, depart: b.start_time,
      hours: Math.round(hours * 10) / 10, place: a.destination, truck: truckName.get(a.asset_id) ?? null,
    });
  }
  return { segments, parked };
}
