/**
 * legPay — the ONE place that answers "what is this leg's slice of the
 * load, and what percentage of it is the driver being paid?"
 *
 * Why this file exists
 * --------------------
 * Driver pay on a relay used to be computed against the WHOLE load
 * price everywhere: the calendar modal, the load detail page, the
 * create endpoint and the dispatch app all did
 * `pay = loadPrice × pct/100`. Meanwhile the payroll page pro-rated
 * revenue by leg miles. The same leg therefore read "8.1%" in the
 * modal and "27%" on the payroll page — two true numbers with two
 * different denominators and nothing on screen naming either one.
 *
 * Everything that turns a load price into a per-leg figure now goes
 * through here, and every percentage rendered next to a pay figure
 * carries a basis label ("of leg" / "of load") so the denominator is
 * never left to the reader.
 *
 * The proration rule (identical to the server's timeline proration and
 * to what PayrollView's DriverCard used to compute inline):
 *
 *   leg share = loadPrice × (thisLeg.loadedMiles / Σ legs.loadedMiles)
 *
 * with an even `loadPrice / legCount` fallback the moment ANY leg is
 * missing usable miles — crediting the whole load to one leg because
 * its sibling hasn't been geocoded yet is far worse than an even split.
 * A load with one leg is its own share: `loadPrice`.
 */

/** Whatever a percentage is being taken OF. Rendered next to every pay
 *  percentage so "27%" can never be mistaken for "27% of the load". */
export type PayBasis = 'leg' | 'load';

export const PAY_BASIS_LABEL: Record<PayBasis, string> = {
  leg:  'of leg',
  load: 'of load',
};

/** Minimum shape needed to weight a leg. Both `CalendarEvent` and the
 *  `Load` row satisfy it, so callers never have to convert. */
export interface LegMilesLike {
  loadedMiles?: number | null;
}

/** A usable mileage number, or null. Zero and negatives are "unknown" —
 *  a leg that genuinely hauled zero miles carries no revenue weight
 *  either way, and treating 0 as known would zero out its share while
 *  its sibling absorbed the entire price. */
function usableMiles(mi: number | null | undefined): number | null {
  return typeof mi === 'number' && Number.isFinite(mi) && mi > 0 ? mi : null;
}

/**
 * Share (0..1) of a load that belongs to ONE leg, weighted by miles.
 *
 * `allLegMiles` is every leg of the load INCLUDING this one, in any
 * order. Returns 1 for a single-leg (non-relay) load. Falls back to
 * 1/N when any leg's miles are unknown.
 */
export function legMilesShare(
  legMiles:    number | null | undefined,
  allLegMiles: ReadonlyArray<number | null | undefined>,
): number {
  const n = allLegMiles.length;
  if (n <= 1) return 1;
  const known = allLegMiles.map(usableMiles);
  if (known.some(m => m === null)) return 1 / n;
  const total = known.reduce<number>((s, m) => s + (m ?? 0), 0);
  if (total <= 0) return 1 / n;
  return (usableMiles(legMiles) ?? 0) / total;
}

/**
 * The revenue ONE leg is responsible for — the denominator every
 * per-leg pay percentage should use. Non-relay loads (a single entry
 * in `allLegMiles`) return the whole load price unchanged.
 */
export function legRevenueShare(
  loadPrice:   number | null | undefined,
  legMiles:    number | null | undefined,
  allLegMiles: ReadonlyArray<number | null | undefined>,
): number {
  const lp = typeof loadPrice === 'number' && Number.isFinite(loadPrice) ? loadPrice : 0;
  if (lp <= 0) return 0;
  return lp * legMilesShare(legMiles, allLegMiles);
}

/**
 * Event-shaped convenience: the revenue for `leg` given every leg of
 * its load. This is the exact rule PayrollView's DriverCard computed
 * inline — extracted so payroll, the calendar modal and the load page
 * cannot drift apart.
 *
 * The authoritative load price is the MAX across legs: it covers both
 * the common case (loadPrice duplicated onto every leg row) and the
 * case where it was only ever set on one of them.
 */
export function legRevenueOf(
  leg:     LegMilesLike & { loadPrice?: number | null },
  allLegs: ReadonlyArray<LegMilesLike & { loadPrice?: number | null }>,
): number {
  if (allLegs.length <= 1) return leg.loadPrice ?? 0;
  const totalPrice = Math.max(...allLegs.map(e => e.loadPrice ?? 0));
  if (totalPrice <= 0) return 0;
  return legRevenueShare(totalPrice, leg.loadedMiles, allLegs.map(e => e.loadedMiles));
}

/**
 * Every leg's revenue share for a load, in the order given. Useful
 * when a surface renders all legs at once (the relay editor, the load
 * page's per-leg pay grid) and wants each leg's denominator without
 * recomputing the total N times.
 */
export function legRevenues(
  loadPrice: number | null | undefined,
  allLegMiles: ReadonlyArray<number | null | undefined>,
): number[] {
  return allLegMiles.map(m => legRevenueShare(loadPrice, m, allLegMiles));
}

/**
 * `pay / base` as a percentage rounded to one decimal, or null when
 * either side is missing. ALWAYS render the result beside a
 * PAY_BASIS_LABEL — a bare percentage is what caused the 8.1%-vs-27%
 * confusion this module exists to end.
 */
export function payPctOf(
  pay:  number | null | undefined,
  base: number | null | undefined,
): number | null {
  if (typeof pay !== 'number' || !Number.isFinite(pay) || pay <= 0) return null;
  if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return null;
  return Math.round((pay / base) * 1000) / 10;
}

/** The auto-computed pay for a base amount at the org's configured
 *  percentage, rounded to cents. `base` is the LEG's share on a relay
 *  and the whole load price on a solo load. */
export function autoPayFor(
  base: number | null | undefined,
  pct:  number | null | undefined,
): number | null {
  if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return null;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return null;
  return Math.round(base * (pct / 100) * 100) / 100;
}

/** Percent formatted the way every chip in the app formats it: no
 *  trailing ".0", one decimal otherwise. */
export function fmtPct(p: number): string {
  return p % 1 === 0 ? p.toFixed(0) : p.toFixed(1);
}

/** True when `pay` is (within a cent) the auto figure for `base` at
 *  `pct` — drives the "auto" chip styling and hides the reset button
 *  when there is nothing to reset to. */
export function payMatchesPct(
  pay:  number | null | undefined,
  base: number | null | undefined,
  pct:  number | null | undefined,
): boolean {
  const auto = autoPayFor(base, pct);
  if (auto == null || typeof pay !== 'number') return false;
  return Math.abs(pay - auto) < 0.01;
}

/**
 * Re-prorate ONE whole-load pay figure across N legs by their miles.
 * Used when a solo load is split into legs: the figure the dispatcher
 * entered was the pay for the WHOLE haul, so leaving it on leg 1 would
 * silently overpay leg 1 and leave the rest at zero.
 *
 * The last leg absorbs the rounding remainder so Σ legs === the
 * original total to the cent — the amount agreed for the load must not
 * change just because it was subdivided.
 */
export function proratePayAcrossLegs(
  totalPay:    number,
  allLegMiles: ReadonlyArray<number | null | undefined>,
): number[] {
  const n = allLegMiles.length;
  if (n === 0) return [];
  if (n === 1) return [Math.round(totalPay * 100) / 100];
  const out = allLegMiles.map(m =>
    Math.round(totalPay * legMilesShare(m, allLegMiles) * 100) / 100);
  const drift = Math.round((totalPay - out.reduce((s, v) => s + v, 0)) * 100) / 100;
  if (drift !== 0) out[n - 1] = Math.round((out[n - 1] + drift) * 100) / 100;
  return out;
}
