/**
 * Prints one truck's calendar stops and GPS visits side by side for a
 * window, with what the linker matched. Read-only; for diagnosing the
 * accuracy report (docs/movement-linking.md).
 *
 *   railway run --service @fleetcal/api npx tsx apps/api/scripts/movement-link-debug.ts <orgId> <truck name> <from YYYY-MM-DD> <to YYYY-MM-DD>
 */

import { loadOrgLinkInputs, wallClockToUtc } from "../src/lib/movementLinkerData.js";
import { linkTruck, sequenceStops } from "../src/lib/movementLinker.js";

const [orgId, truckName, from, to] = process.argv.slice(2);
const inputs = await loadOrgLinkInputs(orgId, from, to);
const t = inputs.trucks.find((x) => x.name === truckName);
if (!t) { console.error(`no truck ${truckName}; have ${inputs.trucks.map((x) => x.name).join(", ")}`); process.exit(1); }
const res = linkTruck({ drives: t.drives, events: t.events, homes: inputs.homes });
const a = wallClockToUtc(`${from}T00:00`, inputs.timeZone)!;
const b = wallClockToUtc(`${to}T23:59`, inputs.timeZone)!;
const loc = (ms: number) => Number.isFinite(ms)
  ? new Date(ms).toLocaleString("en-US", { timeZone: inputs.timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  : "…";

const anchorOf = new Map(res.legs.flatMap((l) => l.stops.map((s) => [s.stopId, s] as const)));
const legOf = new Map(t.events.map((e) => [e.id, e]));
type Line = { at: number; text: string };
const lines: Line[] = [];
for (const s of sequenceStops(t.events)) {
  if (s.t < a - 6 * 3_600_000 || s.t > b + 6 * 3_600_000) continue;
  const an = anchorOf.get(s.id);
  const e = legOf.get(s.event.id)!;
  const m = an?.visitIdx != null ? `→ V${an.visitIdx} (${an.distMi?.toFixed(2)} mi, ${an.offH?.toFixed(1)} h off)` : `✗ ${an?.issue}${an?.nearest ? ` closest ${an.nearest.distMi.toFixed(1)} mi ${an.nearest.offH.toFixed(1)} h` : ""}`;
  lines.push({ at: s.t, text: `  CAL  ${loc(s.t)}  #${e.loadNum ?? "?"} ${s.label}  ${m}` });
}
for (const v of res.visits) {
  if (v.depart < a || v.arrive > b) continue;
  const vl = res.visitLinks[v.idx];
  const hrs = Number.isFinite(v.arrive) && Number.isFinite(v.depart) ? ((v.depart - v.arrive) / 3_600_000).toFixed(1) : "?";
  const where = v.home?.name ?? (v.coord ? `${v.coord.lat.toFixed(3)},${v.coord.lon.toFixed(3)}` : "?");
  lines.push({ at: Number.isFinite(v.arrive) ? v.arrive : v.depart, text: `GPS V${v.idx}  ${loc(v.arrive)} – ${loc(v.depart)}  ${hrs} h at ${where}  [${vl.role}]` });
}
for (const d of res.drives) {
  if (d.start < a || d.start > b || d.miles < 1) continue;
  lines.push({ at: d.start + 1, text: `        drive ${loc(d.start)} ${d.miles.toFixed(0)} mi  ${d.role}${d.eventId ? ` #${legOf.get(d.eventId)?.loadNum ?? ""}` : ""}  — ${d.reason}` });
}
lines.sort((x, y) => x.at - y.at);
console.log(`${t.name} · ${from} → ${to}`);
for (const l of lines) console.log(l.text);
