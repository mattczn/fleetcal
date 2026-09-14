/**
 * Short-haul (150 air-mile) exemption geometry.
 *
 * 49 CFR 395.1(e)(1) exempts a driver from keeping a record of duty
 * status when they operate within a 150 AIR-mile radius of their normal
 * work reporting location and are released within 14 hours. Air miles,
 * not road miles: it's a straight-line radius, so a 200-mile drive that
 * loops back stays inside it while a 160-mile straight shot does not.
 * 150 air miles ≈ 172.6 statute miles.
 *
 * Two things this module is deliberately NOT:
 *
 *   It is not a compliance determination. It classifies a shift so
 *   dispatch knows a log is owed; the driver's actual obligation
 *   depends on what they really drove, which we learn afterwards.
 *
 *   It is not a router. Distance is computed from the terminal to each
 *   stop independently — the question is "did any point of the day fall
 *   outside the circle", not how far they travelled getting there.
 *
 * Pure: no I/O, no clock reads. Run the checks in airMiles.verify.ts.
 */

/** Mean Earth radius in statute miles. An air mile is a statute mile;
 *  the "air" only signifies straight-line rather than road distance. */
const EARTH_RADIUS_MILES = 3958.7613;

/** §395.1(e)(1)(i). */
export const SHORT_HAUL_RADIUS_MILES = 150;

export interface Coord {
  lat: number;
  lon: number;
}

export function isUsableCoord(c: Partial<Coord> | null | undefined): c is Coord {
  if (!c) return false;
  const { lat, lon } = c;
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  // Null Island is what a failed geocode looks like, not a real stop.
  return !(lat === 0 && lon === 0);
}

/**
 * Great-circle distance in statute miles.
 *
 * Haversine rather than the simpler equirectangular approximation:
 * across the distances that matter here (100–200 miles at ~40°N) the
 * flat approximation drifts by a couple of miles, which is precisely
 * the margin that decides whether a shift crosses the 150-mile line.
 */
export function airMilesBetween(a: Coord, b: Coord): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface StopPoint extends Coord {
  /** For explaining the classification back to a dispatcher. */
  label?: string | null;
}

export type ShiftClassification = "local" | "otr";

export interface ClassificationResult {
  classification: ShiftClassification;
  /** Distance to the furthest usable stop, or null when nothing was
   *  geocoded well enough to measure. */
  maxAirMiles: number | null;
  /** The stop that decided it — what to show dispatch. */
  furthestStop: StopPoint | null;
  /** Stops that had no usable coordinate. A shift classified local on
   *  partial data is a guess, and the caller needs to know that. */
  ungeocodedCount: number;
  /**
   * False when there was nothing measurable — no loads assigned, or no
   * stop geocoded. The caller must NOT record a computed classification
   * in that case: "no loads found" and "loads that stay local" produce
   * the same `local` answer, and silently stamping the second onto the
   * first would clear an OTR flag a dispatcher had been relying on.
   */
  decided: boolean;
}

/**
 * Classify a day's work against the short-haul radius.
 *
 * Any single stop outside the radius makes the whole shift OTR — the
 * exemption is lost for the day, not pro-rated.
 */
export function classifyByAirMiles(
  terminal: Coord,
  stops: Array<Partial<StopPoint> | null | undefined>,
  radiusMiles: number = SHORT_HAUL_RADIUS_MILES,
): ClassificationResult {
  let maxAirMiles: number | null = null;
  let furthestStop: StopPoint | null = null;
  let ungeocodedCount = 0;

  for (const raw of stops) {
    if (!isUsableCoord(raw)) { ungeocodedCount++; continue; }
    const stop = raw as StopPoint;
    const miles = airMilesBetween(terminal, stop);
    if (maxAirMiles === null || miles > maxAirMiles) {
      maxAirMiles = miles;
      furthestStop = stop;
    }
  }

  if (maxAirMiles === null) {
    return {
      classification: "local",
      maxAirMiles: null,
      furthestStop: null,
      ungeocodedCount,
      decided: false,
    };
  }

  return {
    classification: maxAirMiles > radiusMiles ? "otr" : "local",
    maxAirMiles,
    furthestStop,
    ungeocodedCount,
    decided: true,
  };
}

/** Parse the terminal out of org_settings.hos_settings. Returns null
 *  when unset — callers skip auto-classification rather than measuring
 *  from a guessed origin, which would be worse than not measuring. */
export function parseTerminal(
  hosSettings: { homeTerminalLat?: unknown; homeTerminalLon?: unknown } | null | undefined,
): Coord | null {
  const lat = Number(hosSettings?.homeTerminalLat);
  const lon = Number(hosSettings?.homeTerminalLon);
  return isUsableCoord({ lat, lon }) ? { lat, lon } : null;
}
