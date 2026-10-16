/**
 * Read-only accuracy report for the movement linker (docs/movement-linking.md).
 * Reads GPS + calendar, runs the rules engine in memory, prints how well it
 * lines up, and optionally writes every leg's result to a JSON file. Writes
 * nothing to the database.
 *
 *   railway run --service @fleetcal/api npx tsx apps/api/scripts/movement-link-report.ts <orgId> <from> <to> [out.json]
 */

import { writeFileSync } from "node:fs";
import { loadOrgLinkInputs, wallClockToUtc } from "../src/lib/movementLinkerData.js";
import { LINK_RULES, linkTruck, otherTrucksAt, type CalEvent, type LegActual, type LinkRole, type Visit } from "../src/lib/movementLinker.js";
import { airMilesBetween, isUsableCoord, SHORT_HAUL_RADIUS_MILES } from "../src/lib/airMiles.js";

const [orgId, from, to, outPath] = process.argv.slice(2);
if (!orgId || !from || !to) {
  console.error("usage: movement-link-report.ts <orgId> <from YYYY-MM-DD> <to YYYY-MM-DD> [out.json]");
  process.exit(1);
}

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");

// LINK_RULES overrides for experiments, e.g. LINK_RULES='{"concurrentOverlapH":999}'.
const overrides = JSON.parse(process.env.LINK_RULES ?? "{}") as Partial<typeof LINK_RULES>;
const inputs = await loadOrgLinkInputs(orgId, from, to);
const winFrom = wallClockToUtc(`${from}T00:00`, inputs.timeZone)!;
const winTo = wallClockToUtc(`${to}T23:59`, inputs.timeZone)!;
const inWin = (t: number) => t >= winFrom && t <= winTo;

type Row = LegActual & { truck: string; assetId: number; start: number; cls: "local" | "otr" | null; noGps: boolean };
const fleet: Array<{ assetId: number; name: string; visits: Visit[] }> = [];
const legs: Row[] = [];
const milesByRole = new Map<LinkRole, number>();
let gpsMiles = 0;

for (const t of inputs.trucks) {
  const res = linkTruck({ drives: t.drives, events: t.events, homes: inputs.homes, rules: { ...LINK_RULES, ...overrides } });
  fleet.push({ assetId: t.assetId, name: t.name, visits: res.visits });
  const evById = new Map<string, CalEvent>(t.events.map((e) => [e.id, e]));
  for (const d of res.drives) {
    if (!inWin(d.start)) continue;
    gpsMiles += d.miles;
    milesByRole.set(d.role, (milesByRole.get(d.role) ?? 0) + d.miles);
  }
  // Miles the odometer moved while the ELD was off.
  const gap = res.visits.filter((v) => v.gap?.missingMiles && inWin(v.arrive)).reduce((n, v) => n + (v.gap!.missingMiles ?? 0), 0);
  milesByRole.set("gps_gap", (milesByRole.get("gps_gap") ?? 0) + gap);
  gpsMiles += gap;
  for (const l of res.legs) {
    const e = evById.get(l.eventId)!;
    if (!inWin(e.start)) continue;
    const pts = e.stops.map((s) => s.coord).filter(isUsableCoord);
    const cls = inputs.terminal && pts.length
      ? (pts.some((p) => airMilesBetween(inputs.terminal!, p) > SHORT_HAUL_RADIUS_MILES) ? "otr" : "local")
      : null;
    legs.push({ ...l, truck: t.name, assetId: t.assetId, start: e.start, cls, noGps: !t.hasGps || t.drives.length === 0 });
  }
}

const rev = legs.filter((l) => l.revenue);
const gps = rev.filter((l) => !l.noGps);
console.log(`\nMovement linker · ${from} → ${to} · ${inputs.trucks.length} trucks · tz ${inputs.timeZone}`);
console.log(`Revenue legs: ${rev.length}  (${rev.length - gps.length} on trucks without GPS, left out below)`);
for (const c of ["high", "medium", "low"] as const) {
  const n = gps.filter((l) => l.confidence === c).length;
  console.log(`  ${c.padEnd(6)} ${String(n).padStart(5)}  ${pct(n, gps.length)}`);
}
const issueCount = new Map<string, number>();
for (const l of gps) for (const i of l.issues) issueCount.set(i, (issueCount.get(i) ?? 0) + 1);
console.log("Leg issues:", [...issueCount].map(([k, v]) => `${k} ${v}`).join(" · ") || "none");

const stops = gps.flatMap((l) => l.stops);
const anchored = stops.filter((s) => s.visitIdx != null);
console.log(`\nStops: ${stops.length} · anchored ${pct(anchored.length, stops.length)} · no coords ${stops.filter((s) => s.issue === "stop_no_coords").length} · GPS off ${stops.filter((s) => s.issue === "gps_gap").length} · out of order ${stops.filter((s) => s.issue === "stop_out_of_order").length} · not found ${stops.filter((s) => s.issue === "stop_not_found").length}`);
const nf = stops.filter((s) => s.issue === "stop_not_found");
const band = (lo: number, hi: number) => nf.filter((s) => s.nearest && s.nearest.distMi >= lo && s.nearest.distMi < hi).length;
console.log(`  not found — truck's closest approach: 3–10 mi ${band(3, 10)} · 10–50 mi ${band(10, 50)} · 50+ mi ${band(50, Infinity)} · no GPS in window ${nf.filter((s) => !s.nearest).length}`);
// Was a DIFFERENT truck at the stop around the calendar time? (A truck swap
// the calendar doesn't show.)
const swaps = new Map<string, string[]>();
for (const l of gps) for (const s of l.stops) {
  if (s.issue !== "stop_not_found" && s.issue !== "stop_out_of_order") continue;
  swaps.set(s.stopId, otherTrucksAt(s, fleet, l.assetId).map((o) => o.name));
}
for (const issue of ["stop_not_found", "stop_out_of_order"] as const) {
  const ss = gps.flatMap((l) => l.stops).filter((s) => s.issue === issue);
  const one = ss.filter((s) => swaps.get(s.stopId)?.length === 1).length;
  const many = ss.filter((s) => (swaps.get(s.stopId)?.length ?? 0) > 1).length;
  console.log(`  ${issue}: another truck was there within 1 mi / ±3 h — exactly one ${one} · several ${many} · none ${ss.length - one - many}`);
}
const lowByTruck = new Map<string, [number, number]>();
for (const l of gps) {
  const r = lowByTruck.get(l.truck) ?? [0, 0];
  r[1]++; if (l.confidence === "low") r[0]++;
  lowByTruck.set(l.truck, r);
}
console.log("  low legs by truck:", [...lowByTruck].sort((a, b) => b[1][0] - a[1][0]).map(([k, [lo, n]]) => `${k} ${lo}/${n}`).join(" · "));
const offs = anchored.map((s) => s.offH ?? 0);
console.log(`Calendar time vs GPS (anchored): median ${f1(median(offs))} h outside the visit · p90 ${f1(q(offs, 0.9))} h`);
console.log(`Distance stop pin → where the truck sat: median ${f2(median(anchored.map((s) => s.distMi ?? 0)))} mi · p90 ${f2(q(anchored.map((s) => s.distMi ?? 0), 0.9))} mi`);

console.log(`\nMiles in window (GPS + odometer during GPS gaps): ${Math.round(gpsMiles).toLocaleString()}`);
for (const [r, m] of [...milesByRole].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${r.padEnd(12)} ${Math.round(m).toLocaleString().padStart(9)}  ${pct(m, gpsMiles)}`);
}

const checked = gps.filter((l) => l.stops.every((s) => s.visitIdx != null) && (l.routeMiles ?? 0) > 0 && l.loadedMiles > 0);
const ratios = checked.map((l) => l.loadedMiles / (l.routeMiles as number));
console.log(`\nGPS loaded mi ÷ route mi (${checked.length} fully anchored legs): median ${f2(median(ratios))} · p10 ${f2(q(ratios, 0.1))} · p90 ${f2(q(ratios, 0.9))} · within 0.8–1.25 ${pct(ratios.filter((r) => r >= 0.8 && r <= 1.25).length, ratios.length)}`);

for (const cls of ["local", "otr"] as const) {
  const ls = gps.filter((l) => l.cls === cls && l.confidence !== "low");
  const loaded = ls.reduce((a, l) => a + l.loadedMiles, 0);
  const dh = ls.reduce((a, l) => a + l.deadheadMiles, 0);
  const ret = ls.reduce((a, l) => a + l.returnMiles, 0);
  const hours = ls.map((l) => l.loadedHours + l.dwellHours + l.deadheadHours + l.returnHours + l.restHours);
  console.log(`\n${cls.toUpperCase()} (${ls.length} legs, high+medium)`);
  console.log(`  loaded ${Math.round(loaded).toLocaleString()} mi · deadhead ${Math.round(dh).toLocaleString()} · return ${Math.round(ret).toLocaleString()} → driven per loaded mile ${f2((loaded + dh + ret) / loaded)}`);
  console.log(`  per leg median: loaded ${f1(median(ls.map((l) => l.loadedMiles)))} mi / ${f1(median(ls.map((l) => l.loadedHours)))} h · dwell ${f1(median(ls.map((l) => l.dwellHours)))} h · truck hours on the leg ${f1(median(hours))} (p90 ${f1(q(hours, 0.9))})`);
}

const dwellByPlace = new Map<string, number[]>();
for (const l of gps) for (const s of l.stops) {
  if (s.arrive == null || s.depart == null || s.kind === "handoff") continue;
  dwellByPlace.set(s.label, [...(dwellByPlace.get(s.label) ?? []), (s.depart - s.arrive) / 3_600_000]);
}
const places = [...dwellByPlace].filter(([, v]) => v.length >= 8).map(([k, v]) => ({ k, n: v.length, med: median(v) })).sort((a, b) => b.med - a.med);
console.log("\nLongest median dwell (≥ 8 visits):");
for (const p of places.slice(0, 10)) console.log(`  ${f1(p.med).padStart(5)} h  ×${String(p.n).padStart(3)}  ${p.k}`);

console.log("\nSample low-confidence legs:");
const perTruck = new Map<string, number>();
const sample = gps.filter((x) => x.confidence === "low").filter((x) => {
  const n = perTruck.get(x.truck) ?? 0;
  perTruck.set(x.truck, n + 1);
  return n < 2;
});
for (const l of sample.slice(0, 20)) {
  const miss = l.stops.filter((s) => s.issue)
    .map((s) => `${s.label} (${s.issue}${s.nearest ? `, closest ${f1(s.nearest.distMi)} mi ${f1(s.nearest.offH)} h off` : ""}${swaps.get(s.stopId)?.length ? `; there: ${swaps.get(s.stopId)!.join(", ")}` : ""})`)
    .join("; ") || "no stops on the leg";
  console.log(`  #${l.loadNum} ${new Date(l.start).toISOString().slice(0, 16)}Z ${l.truck}: ${miss}`);
}

if (outPath) {
  writeFileSync(outPath, JSON.stringify({ from, to, milesByRole: Object.fromEntries(milesByRole), legs }, null, 1));
  console.log(`\nWrote ${legs.length} legs to ${outPath}`);
}
