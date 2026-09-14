/**
 * Verification for lib/airMiles.ts — run with:
 *   npx tsx src/lib/airMiles.verify.ts     (from apps/api)
 *
 * Distances are checked against known city pairs so the haversine is
 * anchored to reality rather than to itself. Curzon runs out of Salt
 * Lake, so the boundary cases use real destinations they'd actually
 * see: Ogden and Provo inside the radius, Vegas and Denver well
 * outside, and St George / Rock Springs near enough to the line that a
 * sloppy approximation would classify them wrong.
 */
import {
  airMilesBetween, classifyByAirMiles, isUsableCoord, parseTerminal,
  SHORT_HAUL_RADIUS_MILES,
} from "./airMiles.js";

let passed = 0, failed = 0;
const ok = (label: string, cond: boolean, extra?: unknown) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
};
const near = (label: string, actual: number, expected: number, tol: number) => {
  if (Math.abs(actual - expected) <= tol) { passed++; console.log(`  ok   ${label} (${actual.toFixed(1)} mi)`); }
  else { failed++; console.log(`  FAIL ${label} — expected ~${expected}, got ${actual.toFixed(1)}`); }
};
const section = (n: string) => console.log(`\n${n}`);

// Salt Lake City — stand-in terminal until the real yard is configured.
const SLC        = { lat: 40.7608, lon: -111.8910 };
const OGDEN      = { lat: 41.2230, lon: -111.9738 };
const PROVO      = { lat: 40.2338, lon: -111.6585 };
const LOGAN      = { lat: 41.7370, lon: -111.8338 };
const ST_GEORGE  = { lat: 37.0965, lon: -113.5684 };
const LAS_VEGAS  = { lat: 36.1699, lon: -115.1398 };
const DENVER     = { lat: 39.7392, lon: -104.9903 };
const ROCK_SPR   = { lat: 41.5875, lon: -109.2029 };
const BOISE      = { lat: 43.6150, lon: -116.2023 };

section("distance sanity");
near("SLC → Ogden", airMilesBetween(SLC, OGDEN), 33, 3);
near("SLC → Provo", airMilesBetween(SLC, PROVO), 38, 3);
near("SLC → Logan", airMilesBetween(SLC, LOGAN), 67, 4);
near("SLC → Rock Springs", airMilesBetween(SLC, ROCK_SPR), 148, 8);
near("SLC → St George", airMilesBetween(SLC, ST_GEORGE), 267, 10);
near("SLC → Las Vegas", airMilesBetween(SLC, LAS_VEGAS), 368, 12);
near("SLC → Denver", airMilesBetween(SLC, DENVER), 371, 12);
near("SLC → Boise", airMilesBetween(SLC, BOISE), 291, 12);
ok("distance is symmetric",
  Math.abs(airMilesBetween(SLC, DENVER) - airMilesBetween(DENVER, SLC)) < 0.001);
near("zero distance to self", airMilesBetween(SLC, SLC), 0, 0.001);

section("classification");
{
  const r = classifyByAirMiles(SLC, [OGDEN, PROVO, LOGAN]);
  ok("Wasatch Front stays local", r.classification === "local", r);
  ok("decided", r.decided, r);
}
{
  const r = classifyByAirMiles(SLC, [OGDEN, LAS_VEGAS, PROVO]);
  ok("one far stop makes the whole day OTR", r.classification === "otr", r);
  near("furthest wins", r.maxAirMiles ?? -1, 368, 12);
}
{
  // The exemption is lost for the DAY — it isn't pro-rated across stops.
  const r = classifyByAirMiles(SLC, [ST_GEORGE]);
  ok("single out-of-range stop is OTR", r.classification === "otr");
}
{
  // Rock Springs lands at 151.0 air miles — one mile the wrong side of
  // the line. Worth knowing operationally: a Rock Springs run costs the
  // short-haul exemption, and an equirectangular approximation drifts
  // enough at this latitude to call it either way, which is the whole
  // reason this uses haversine.
  const r = classifyByAirMiles(SLC, [ROCK_SPR]);
  near("Rock Springs is right on the boundary", r.maxAirMiles ?? -1, 151, 2);
  ok("and falls just outside → OTR", r.classification === "otr", r.maxAirMiles);
}
{
  // Evanston WY, ~78 miles out — comfortably inside.
  const evanston = { lat: 41.2683, lon: -110.9632 };
  const r = classifyByAirMiles(SLC, [evanston]);
  ok("Evanston stays local", r.classification === "local", r.maxAirMiles);
}
{
  // Exactly at the radius is INSIDE — the reg says "within 150 air
  // miles", so the comparison has to be strictly-greater to be outside.
  // Tested by passing the measured distance back as the radius, which
  // checks the comparison itself rather than my ability to construct a
  // point sitting precisely on the line.
  const exact = airMilesBetween(SLC, OGDEN);
  ok("a stop exactly at the radius counts as within",
    classifyByAirMiles(SLC, [OGDEN], exact).classification === "local");
  ok("a hair inside the radius is outside",
    classifyByAirMiles(SLC, [OGDEN], exact - 0.001).classification === "otr");
}
{
  const justOutside = { lat: SLC.lat + 2.6, lon: SLC.lon }; // ~180 mi due north
  const r = classifyByAirMiles(SLC, [justOutside]);
  ok("just-outside stop is OTR", r.classification === "otr", r.maxAirMiles);
}

section("bad data");
{
  const r = classifyByAirMiles(SLC, []);
  ok("no stops → undecided", r.decided === false, r);
  ok("undecided still defaults to local", r.classification === "local");
  ok("no max distance", r.maxAirMiles === null);
}
{
  const r = classifyByAirMiles(SLC, [null, undefined, { lat: null as unknown as number, lon: 5 }]);
  ok("all-ungeocoded → undecided", r.decided === false, r);
  ok("ungeocoded counted", r.ungeocodedCount === 3, r.ungeocodedCount);
}
{
  // A failed geocode lands on Null Island; measuring to it would put
  // every Utah shift ~7000 miles out and flag the fleet OTR.
  const r = classifyByAirMiles(SLC, [{ lat: 0, lon: 0 }, OGDEN]);
  ok("0,0 is rejected, not measured", r.classification === "local", r.maxAirMiles);
  ok("and counted as ungeocoded", r.ungeocodedCount === 1);
}
{
  const r = classifyByAirMiles(SLC, [LAS_VEGAS, null]);
  ok("partial geocoding still decides when one stop is far", r.decided && r.classification === "otr");
  ok("but reports the gap", r.ungeocodedCount === 1);
}

section("coordinate guards");
ok("rejects null", !isUsableCoord(null));
ok("rejects out-of-range lat", !isUsableCoord({ lat: 91, lon: 0 }));
ok("rejects out-of-range lon", !isUsableCoord({ lat: 0, lon: 181 }));
ok("rejects NaN", !isUsableCoord({ lat: NaN, lon: 0 }));
ok("rejects 0,0", !isUsableCoord({ lat: 0, lon: 0 }));
ok("accepts SLC", isUsableCoord(SLC));

section("terminal config");
ok("missing settings → null", parseTerminal(null) === null);
ok("empty settings → null", parseTerminal({}) === null);
ok("0,0 terminal rejected", parseTerminal({ homeTerminalLat: 0, homeTerminalLon: 0 }) === null);
{
  const t = parseTerminal({ homeTerminalLat: 40.7608, homeTerminalLon: -111.891 });
  ok("valid terminal parsed", t?.lat === 40.7608 && t?.lon === -111.891, t);
}
{
  // JSONB round-trips can hand these back as strings.
  const t = parseTerminal({ homeTerminalLat: "40.7608", homeTerminalLon: "-111.891" });
  ok("string coords coerced", t?.lat === 40.7608, t);
}

ok(`radius constant is 150`, SHORT_HAUL_RADIUS_MILES === 150);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
