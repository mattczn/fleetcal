/**
 * Standard pay by area: areas drawn on a map and the pay for a lane
 * between them (lib/routePay.ts uses these to suggest pay).
 *
 *   Area   a named polygon. A stop inside two areas belongs to the smaller
 *          one, so a tight area around one facility can sit inside a
 *          metro area and win.
 *   Lane   from area → to area × kind: pickup (shipper → yard), delivery
 *          (yard → consignee), whole (shipper → consignee), transfer only
 *          (yard → yard). A leg's lane comes from its first and last stop.
 *          Its direction follows the base — the home area holding the
 *          org's home terminal (SLC): outbound leaves it, inbound comes
 *          back, local stays in one area or one home area, through touches
 *          neither. Other home areas (Vegas, where a local driver does
 *          pickups) only keep work inside them local; without a terminal
 *          every home area is a base. Stops past two add the lane's own
 *          extra-stop amount, else the general one.
 */

import type { LaneDirection, PayArea, PayAreaPoint, PayLane, RateGroup } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { parseTerminal } from "./airMiles.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

export class PayAreasUnavailableError extends Error {}
const KINDS: RateGroup[] = ["pickup", "delivery", "whole", "transfer"];

interface AreaRow { id: number; name: string; color: string; polygon: PayAreaPoint[]; is_home: boolean }
interface LaneRow {
  id: number; from_area_id: number; to_area_id: number; kind: RateGroup; amount: number | string; extra_stop: number | string | null;
  note: string | null; set_by_name: string | null; set_at: string;
}

const toArea = (r: AreaRow): PayArea => ({ id: Number(r.id), name: r.name, color: r.color, polygon: r.polygon, isHome: !!r.is_home, homeId: r.is_home ? Number(r.id) : null });

/** An area drawn inside a home base counts as that base. */
function withHomes(areas: PayArea[]): PayArea[] {
  const homes = areas.filter((a) => a.isHome && a.polygon.length >= 3).sort((x, y) => sizeOf(x.polygon) - sizeOf(y.polygon));
  return areas.map((a) => {
    if (a.isHome || !a.polygon.length) return a;
    const c = { lat: a.polygon.reduce((s, p) => s + p.lat, 0) / a.polygon.length, lng: a.polygon.reduce((s, p) => s + p.lng, 0) / a.polygon.length };
    const home = homes.find((h) => inPolygon(c, h.polygon));
    return home ? { ...a, homeId: home.id } : a;
  });
}
const toLane = (r: LaneRow): PayLane => ({
  id: Number(r.id), fromAreaId: Number(r.from_area_id), toAreaId: Number(r.to_area_id), kind: r.kind,
  amount: Number(r.amount), extraStop: r.extra_stop == null ? null : Number(r.extra_stop),
  note: r.note, setByName: r.set_by_name, setAt: r.set_at,
});

export function laneDirection(from: PayArea, to: PayArea, baseId: number | null = null): LaneDirection {
  if (from.id === to.id || (from.homeId != null && from.homeId === to.homeId)) return "local";
  const atBase = (a: PayArea) => (baseId != null ? a.homeId === baseId : a.homeId != null);
  if (atBase(from) && !atBase(to)) return "outbound";
  if (atBase(to) && !atBase(from)) return "inbound";
  return "through";
}

/** Areas, lanes and the base (see laneDirection); available=false until the migration has been run. */
export async function readAreasAndLanes(orgId: string): Promise<{ areas: PayArea[]; lanes: PayLane[]; available: boolean; baseId: number | null }> {
  const [a, l, s] = await Promise.all([
    supabase.from("pay_areas").select("id, name, color, polygon, is_home").eq("org_id", orgId).order("id"),
    supabase.from("pay_lanes").select("id, from_area_id, to_area_id, kind, amount, extra_stop, note, set_by_name, set_at").eq("org_id", orgId).order("id"),
    supabase.from("org_settings").select("hos_settings").eq("org_id", orgId).maybeSingle(),
  ]);
  if (a.error || l.error) return { areas: [], lanes: [], available: false, baseId: null };
  const areas = withHomes((a.data as AreaRow[]).map(toArea));
  const terminal = parseTerminal(s.data?.hos_settings);
  const base = terminal ? areaLocator(areas.filter((x) => x.isHome))({ lat: terminal.lat, lng: terminal.lon }) : null;
  return { areas, lanes: (l.data as LaneRow[]).map(toLane), available: true, baseId: base?.id ?? null };
}

// ── Geometry ────────────────────────────────────────────────────────────

/** Ray casting on lat/lng — fine at the scale of a metro area. */
function inPolygon(pt: PayAreaPoint, poly: PayAreaPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.lat > pt.lat) !== (b.lat > pt.lat) && pt.lng < ((b.lng - a.lng) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}
/** Polygon area in squared degrees (only compared against each other). */
function sizeOf(poly: PayAreaPoint[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].lng + poly[i].lng) * (poly[j].lat - poly[i].lat);
  return Math.abs(s / 2);
}

/** Finds the area a point is in — the smallest one when areas overlap. */
export function areaLocator(areas: PayArea[]) {
  const sized = areas.filter((a) => a.polygon.length >= 3).map((a) => ({ a, size: sizeOf(a.polygon) })).sort((x, y) => x.size - y.size);
  return (pt: PayAreaPoint | null | undefined): PayArea | null => {
    if (!pt) return null;
    for (const { a } of sized) if (inPolygon(pt, a.polygon)) return a;
    return null;
  };
}

// ── Writes ──────────────────────────────────────────────────────────────

function validPolygon(p: unknown): p is PayAreaPoint[] {
  return Array.isArray(p) && p.length >= 3 && p.length <= 500
    && p.every((x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lng) && Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180);
}
const cleanColor = (c: unknown) => (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);

export async function createArea(orgId: string, body: { name?: unknown; color?: unknown; polygon?: unknown; isHome?: unknown }, byName: string | null): Promise<PayArea> {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name || !validPolygon(body.polygon)) throw new Error("validation: a name and a polygon of 3+ points are required");
  const { data, error } = await supabase.from("pay_areas").insert({
    org_id: orgId, name, color: cleanColor(body.color) ?? "#1a73e8",
    polygon: body.polygon.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })), is_home: body.isHome === true, updated_by_name: byName,
  }).select("id, name, color, polygon, is_home").single();
  if (error) throw new PayAreasUnavailableError(`${error.message} — has 20261022_pay_areas.sql been run?`);
  return toArea(data as AreaRow);
}

export async function updateArea(orgId: string, id: number, body: { name?: unknown; color?: unknown; polygon?: unknown; isHome?: unknown }, byName: string | null): Promise<void> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by_name: byName };
  if ("name" in body) {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) throw new Error("validation: name can't be empty");
    update.name = name;
  }
  if ("color" in body) {
    const c = cleanColor(body.color);
    if (!c) throw new Error("validation: color must be #rrggbb");
    update.color = c;
  }
  if ("isHome" in body) update.is_home = body.isHome === true;
  if ("polygon" in body) {
    if (!validPolygon(body.polygon)) throw new Error("validation: polygon needs 3+ points");
    update.polygon = body.polygon.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  }
  const { error } = await supabase.from("pay_areas").update(update).eq("org_id", orgId).eq("id", id);
  if (error) throw new PayAreasUnavailableError(error.message);
}

/** Deleting an area deletes the lanes to and from it. */
export async function deleteArea(orgId: string, id: number): Promise<void> {
  const { error } = await supabase.from("pay_areas").delete().eq("org_id", orgId).eq("id", id);
  if (error) throw new PayAreasUnavailableError(error.message);
}

export async function setLane(
  orgId: string, body: { fromAreaId?: unknown; toAreaId?: unknown; kind?: unknown; amount?: unknown; extraStop?: unknown; note?: unknown }, byName: string | null,
): Promise<void> {
  const from = Number(body.fromAreaId);
  const to = Number(body.toAreaId);
  const kind = body.kind as RateGroup;
  if (!Number.isInteger(from) || !Number.isInteger(to) || !KINDS.includes(kind)) throw new Error("validation: fromAreaId, toAreaId and kind are required");
  if (body.amount === null) {
    const { error } = await supabase.from("pay_lanes").delete().eq("org_id", orgId).eq("from_area_id", from).eq("to_area_id", to).eq("kind", kind);
    if (error) throw new PayAreasUnavailableError(error.message);
    return;
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) throw new Error("validation: amount must be 0–100000 (or null to clear)");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  const extraStop = body.extraStop == null || body.extraStop === "" ? null : Number(body.extraStop);
  if (extraStop != null && (!Number.isFinite(extraStop) || extraStop < 0 || extraStop > 10_000)) throw new Error("validation: extraStop must be 0–10000 or empty");
  const { error } = await supabase.from("pay_lanes").upsert(
    { org_id: orgId, from_area_id: from, to_area_id: to, kind, amount, extra_stop: extraStop, note, set_by_name: byName, set_at: new Date().toISOString() },
    { onConflict: "org_id,from_area_id,to_area_id,kind" },
  );
  if (error) throw new PayAreasUnavailableError(`${error.message} — has 20261022_pay_areas.sql been run?`);
}
