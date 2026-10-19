/**
 * Rate card — driver pay for a leg on a route with no standard, learned
 * from the routes that have one (lib/routePay.ts).
 *
 *   Local legs (every stop inside a region, e.g. 100 mi of the SLC yard):
 *     region × group (pickup to a yard, delivery from a yard, whole load,
 *     transfer) × distance band → the most common pay among the 2-stop
 *     training routes in that cell (pay sits on set amounts, so an
 *     average would be an amount nobody pays), + a learned amount per
 *     stop past two.
 *   OTR legs: the lane, by direction (SLC → Vegas pays $175, Vegas → SLC
 *     $425) — the most common pay of the training routes on that lane; a lane
 *     with none gets the OTR per-mile median, marked as an estimate.
 *
 * Training routes: those with a standard (or a consistent settled usual),
 * minus excluded ones — route keys left out by hand, names / customers
 * matching a pattern (e.g. DCL round trips), and bad stop data (a single
 * place, or an "OTR" leg that starts and ends in the same area). Any cell
 * can be overridden; the override wins and the learned value stays
 * visible next to it.
 */

import type {
  RateCardCell, RateCardConfig, RateCardRef, RateCardRegion, RateCardResponse, RateGroup, RouteLegKind,
} from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { airMilesBetween } from "./airMiles.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

/** OTR endpoints within this of each other are the same lane end. */
const ZONE_RADIUS_MI = 40;
/** A settled usual trains the card only when it's this consistent. */
const USUAL_TRAINS_AT = 0.6;
const MIN_USUAL_LEGS = 3;

export const DEFAULT_RATE_CONFIG: RateCardConfig = {
  regions: [], bands: [10, 30, 65, 105], excludeRoutes: [], excludeNames: [], overrides: {},
};

const GROUP_OF: Record<RouteLegKind, RateGroup> = {
  pickup: "pickup", pickup_linehaul: "pickup",
  delivery: "delivery", linehaul_delivery: "delivery",
  whole_local: "whole", whole_long: "whole",
  transfer: "transfer",
};
export const GROUP_LABEL: Record<RateGroup, string> = {
  pickup: "Pickup → yard", delivery: "Yard → delivery", whole: "Whole load", transfer: "Yard → yard",
};

// ── Config ──────────────────────────────────────────────────────────────

export async function readRateConfig(orgId: string): Promise<{ config: RateCardConfig; available: boolean }> {
  const { data, error } = await supabase.from("route_pay_config").select("config").eq("org_id", orgId).maybeSingle();
  if (error) return { config: DEFAULT_RATE_CONFIG, available: false };
  return { config: { ...DEFAULT_RATE_CONFIG, ...(data?.config ?? {}) }, available: true };
}

export async function writeRateConfig(orgId: string, config: RateCardConfig, byName: string | null): Promise<void> {
  const { error } = await supabase.from("route_pay_config").upsert(
    { org_id: orgId, config, updated_by_name: byName, updated_at: new Date().toISOString() },
    { onConflict: "org_id" },
  );
  if (error) throw new Error(`${error.message} — has 20261019_route_pay_config.sql been run?`);
}

/** Validate a partial config patch; returns the merged config or errors. */
export function mergeRateConfig(current: RateCardConfig, body: unknown): { config?: RateCardConfig; errors: string[] } {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return { errors: ["body must be an object"] };
  const b = body as Record<string, unknown>;
  const next: RateCardConfig = { ...current, overrides: { ...current.overrides } };
  if ("regions" in b) {
    const r = b.regions;
    if (!Array.isArray(r) || r.some((x) => !x || typeof x.name !== "string" || !Number.isFinite(x.lat) || !Number.isFinite(x.lng) || !(x.radiusMi > 0 && x.radiusMi <= 500))) {
      errors.push("regions must be [{ name, lat, lng, radiusMi (0–500) }]");
    } else next.regions = (r as RateCardRegion[]).map((x) => ({ name: x.name.trim().slice(0, 40), lat: x.lat, lng: x.lng, radiusMi: x.radiusMi }));
  }
  if ("bands" in b) {
    const v = b.bands;
    if (!Array.isArray(v) || v.some((x) => !(typeof x === "number" && x > 0 && x < 2000)) || v.some((x, i) => i > 0 && x <= (v[i - 1] as number))) {
      errors.push("bands must be increasing mile limits");
    } else next.bands = v as number[];
  }
  for (const k of ["excludeRoutes", "excludeNames"] as const) {
    if (!(k in b)) continue;
    const v = b[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 120)) errors.push(`${k} must be a list of text`);
    else next[k] = [...new Set((v as string[]).map((x) => x.trim()))];
  }
  if ("overrides" in b) {
    const o = b.overrides;
    if (!o || typeof o !== "object") errors.push("overrides must be an object");
    else {
      for (const [key, v] of Object.entries(o as Record<string, unknown>)) {
        if (v === null) { delete next.overrides[key]; continue; }
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000) errors.push(`overrides.${key} must be 0–10000 or null`);
        else next.overrides[key] = v;
      }
    }
  }
  return errors.length ? { errors } : { config: next, errors };
}

// ── Classifying a leg ───────────────────────────────────────────────────

export interface RatePlace { id: number; lat: number; lng: number; name: string; city: string | null; state: string | null }

export interface RateRoute {
  key: string;
  places: RatePlace[];
  kind: RouteLegKind;
  miles: number;
  label: string;
  name: string | null;
  cities: string;
  customers: string[];
  /** Pay that trains the card (standard, or a consistent usual); null = none. */
  pay: number | null;
  standard: boolean;
  legs: number;
}

type Where =
  | { scope: "local"; region: string; group: RateGroup; band: string; stops: number }
  | { scope: "lane"; from: string; to: string; stops: number }
  | { scope: "none" };

const d = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  airMilesBetween({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });

export function bandOf(miles: number, bands: number[]): string {
  let lo = 0;
  for (const hi of bands) {
    if (miles < hi) return `${lo}-${hi}`;
    lo = hi;
  }
  return `${lo}+`;
}
const bandLabel = (b: string) => (b.endsWith("+") ? `${b.slice(0, -1)}+ mi` : `${b.replace("-", "–")} mi`);

/** OTR lane ends: a region, or a cluster of far endpoints (40 mi). */
class Zones {
  private zones: Array<{ name: string; lat: number; lng: number }> = [];
  constructor(private regions: RateCardRegion[]) {}
  of(p: RatePlace): string {
    for (const r of this.regions) if (d(p, r) <= r.radiusMi) return r.name;
    for (const z of this.zones) if (d(p, z) <= ZONE_RADIUS_MI) return z.name;
    const name = p.city ? [titleCase(p.city), p.state?.toUpperCase()].filter(Boolean).join(", ") : p.name;
    this.zones.push({ name, lat: p.lat, lng: p.lng });
    return name;
  }
}
const titleCase = (t: string) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function whereOf(r: { places: RatePlace[]; kind: RouteLegKind; miles: number }, cfg: RateCardConfig, zones: Zones): Where {
  if (r.places.length < 2) return { scope: "none" };
  const stops = r.places.length;
  for (const reg of cfg.regions) {
    if (r.places.every((p) => d(p, reg) <= reg.radiusMi)) {
      return { scope: "local", region: reg.name, group: GROUP_OF[r.kind], band: bandOf(r.miles, cfg.bands), stops };
    }
  }
  if (!cfg.regions.length) return { scope: "none" };
  const from = zones.of(r.places[0]);
  const to = zones.of(r.places[r.places.length - 1]);
  // Out and back to the same area is a round trip or bad stops, not a lane.
  if (from === to) return { scope: "none" };
  return { scope: "lane", from, to, stops };
}

const cellKeyOf = (w: Where) =>
  w.scope === "local" ? `local|${w.region}|${w.group}|${w.band}` : w.scope === "lane" ? `lane|${w.from}>${w.to}` : null;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round5 = (n: number) => Math.max(0, Math.round(n / 5) * 5);
/** Most common pay across routes (one vote each); ties go to the amount
 *  with more paid legs behind it. */
const modePay = (rs: Array<{ pay: number | null; legs: number }>) => {
  const votes = new Map<number, { n: number; legs: number }>();
  for (const r of rs) {
    const v = votes.get(r.pay!) ?? { n: 0, legs: 0 };
    votes.set(r.pay!, { n: v.n + 1, legs: v.legs + r.legs });
  }
  let best: number | null = null; let bn = -1; let bl = -1;
  for (const [pay, v] of votes) if (v.n > bn || (v.n === bn && v.legs > bl)) { best = pay; bn = v.n; bl = v.legs; }
  return best;
};

// ── The card ────────────────────────────────────────────────────────────

export interface RateCard {
  response: RateCardResponse;
  /** The card's amount for a leg, or null when it has nothing to say. */
  rateFor(r: { places: RatePlace[]; kind: RouteLegKind; miles: number }): {
    amount: number; key: string; label: string; refs: RateCardRef[]; extraStops: number; extraStopAmount: number; estimate: boolean;
  } | null;
  cellOf(routeKey: string): string | null;
}

export function buildRateCard(routes: RateRoute[], cfg: RateCardConfig, available: boolean): RateCard {
  const zones = new Zones(cfg.regions);
  const patterns = cfg.excludeNames.map((p) => p.toLowerCase());
  const excluded = new Set<string>();
  const where = new Map<string, Where>();
  for (const r of routes) {
    const w = whereOf(r, cfg, zones);
    where.set(r.key, w);
    const text = [r.name ?? "", r.label, ...r.customers].join(" ").toLowerCase();
    if (cfg.excludeRoutes.includes(r.key) || patterns.some((p) => text.includes(p)) || w.scope === "none") excluded.add(r.key);
  }
  const ref = (r: RateRoute): RateCardRef => ({
    routeKey: r.key, label: r.label, name: r.name, cities: r.cities, pay: r.pay!, legs: r.legs, standard: r.standard, stops: r.places.length,
  });

  // Training: 2-stop routes set local cells; every lane route sets its lane.
  const cellRoutes = new Map<string, RateRoute[]>();
  const multiStop: RateRoute[] = [];
  for (const r of routes) {
    if (r.pay == null || excluded.has(r.key)) continue;
    const w = where.get(r.key)!;
    const key = cellKeyOf(w)!;
    if (w.scope === "local" && w.stops > 2) { multiStop.push(r); continue; }
    cellRoutes.set(key, [...(cellRoutes.get(key) ?? []), r]);
  }
  const learned = new Map<string, number>();
  for (const [key, rs] of cellRoutes) learned.set(key, modePay(rs)!);
  const valueOf = (key: string) => cfg.overrides[key] ?? learned.get(key) ?? null;

  // Per stop past two, from multi-stop local routes against their cell's base.
  const extraSamples = multiStop.flatMap((r) => {
    const base = valueOf(cellKeyOf(where.get(r.key)!)!);
    return base == null ? [] : [Math.min(100, Math.max(0, (r.pay! - base) / (r.places.length - 2)))];
  });
  const extraLearned = extraSamples.length ? round5(median(extraSamples)!) : null;
  const extraValue = cfg.overrides.extraStop ?? extraLearned ?? 0;

  // OTR per-mile fallback for lanes with nothing to learn from.
  const laneRates = [...cellRoutes.entries()].filter(([k]) => k.startsWith("lane|"))
    .flatMap(([, rs]) => rs.filter((r) => r.miles > 0).map((r) => r.pay! / r.miles));
  const otrPerMile = laneRates.length ? Math.round(median(laneRates)! * 100) / 100 : null;

  // Every cell the config implies (so empty ones can be set), plus lanes seen.
  const cells: RateCardCell[] = [];
  const keys = new Set<string>([...cellRoutes.keys(), ...Object.keys(cfg.overrides).filter((k) => k !== "extraStop")]);
  for (const reg of cfg.regions) {
    for (const g of ["pickup", "delivery", "whole", "transfer"] as RateGroup[]) {
      let lo = 0;
      for (const hi of [...cfg.bands, Infinity]) {
        keys.add(`local|${reg.name}|${g}|${hi === Infinity ? `${lo}+` : `${lo}-${hi}`}`);
        lo = hi;
      }
    }
  }
  for (const key of keys) {
    const parts = key.split("|");
    const refs = (cellRoutes.get(key) ?? []).map(ref).sort((a, b) => b.legs - a.legs);
    if (parts[0] === "local") {
      const [, region, group, band] = parts as [string, string, RateGroup, string];
      // Multi-stop routes show under the cell of their distance.
      refs.push(...multiStop.filter((r) => cellKeyOf(where.get(r.key)!) === key).map(ref));
      cells.push({
        key, scope: "local", region, group, band, lane: null,
        label: `${region} · ${GROUP_LABEL[group] ?? group} · ${bandLabel(band)}`,
        learned: learned.get(key) ?? null, override: cfg.overrides[key] ?? null, value: valueOf(key),
        varies: new Set((cellRoutes.get(key) ?? []).map((r) => r.pay)).size > 1, refs,
      });
    } else {
      const [from, to] = parts[1].split(">");
      cells.push({
        key, scope: "lane", region: null, group: null, band: null, lane: `${from} → ${to}`, label: `${from} → ${to}`,
        learned: learned.get(key) ?? null, override: cfg.overrides[key] ?? null, value: valueOf(key),
        varies: new Set((cellRoutes.get(key) ?? []).map((r) => r.pay)).size > 1, refs,
      });
    }
  }

  const response: RateCardResponse = {
    available, config: cfg, cells, extraStop: { learned: extraLearned, override: cfg.overrides.extraStop ?? null, value: extraValue },
    otrPerMile, excluded: [...excluded],
  };

  return {
    response,
    cellOf: (routeKey) => { const w = where.get(routeKey); return w ? cellKeyOf(w) : null; },
    rateFor(r) {
      const w = whereOf(r, cfg, zones);
      if (w.scope === "none") return null;
      const key = cellKeyOf(w)!;
      const cell = cells.find((c) => c.key === key);
      if (w.scope === "lane") {
        const v = valueOf(key);
        if (v != null) return { amount: v, key, label: `OTR lane · ${w.from} → ${w.to}`, refs: cell?.refs ?? [], extraStops: 0, extraStopAmount: 0, estimate: false };
        if (otrPerMile == null || !(r.miles > 0)) return null;
        return { amount: round5(otrPerMile * r.miles), key, label: `OTR lane · ${w.from} → ${w.to} (no routes yet — $${otrPerMile}/mi)`, refs: [], extraStops: 0, extraStopAmount: 0, estimate: true };
      }
      // Local: this band, else the nearest band of the same group that has a value.
      const order = [...cfg.bands.map((_, i) => i), cfg.bands.length];
      const bandKeys = order.map((i) => bandOf(i === 0 ? 0 : cfg.bands[i - 1], cfg.bands));
      const at = bandKeys.indexOf(w.band);
      const tryKeys = [w.band, ...bandKeys.filter((_, i) => i !== at).sort((a, b) => Math.abs(bandKeys.indexOf(a) - at) - Math.abs(bandKeys.indexOf(b) - at))];
      for (const b of tryKeys) {
        const k = `local|${w.region}|${w.group}|${b}`;
        const v = valueOf(k);
        if (v == null) continue;
        const extra = Math.max(0, w.stops - 2);
        const c = cells.find((x) => x.key === k);
        return {
          amount: round5(v + extra * extraValue), key: k,
          label: `${c?.label ?? k}${b !== w.band ? ` (nearest band to ${bandLabel(w.band)})` : ""}`,
          refs: c?.refs ?? [], extraStops: extra, extraStopAmount: extraValue, estimate: b !== w.band,
        };
      }
      return null;
    },
  };
}

/** A route's training pay: its standard, else a consistent settled usual. */
export function trainingPay(r: { standard: { amount: number } | null; usual: number | null; usualShare: number | null; legs: number }): number | null {
  if (r.standard) return r.standard.amount;
  if (r.usual != null && r.legs >= MIN_USUAL_LEGS && (r.usualShare ?? 0) >= USUAL_TRAINS_AT) return r.usual;
  return null;
}
