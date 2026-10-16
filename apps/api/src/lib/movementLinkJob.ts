/**
 * Saves the movement linker's results (docs/movement-linking.md): a
 * movement_links fact for every settled drive, and one leg_actuals row per
 * leg. Re-runnable — only links that changed are written, a link someone
 * set by hand is never touched, and leg rows are upserted.
 *
 * Links use the vocabulary every existing reader (truck timeline, fleet
 * performance, per-day P&L) already understands: deadhead is a
 * `transition` into the next leg, the return to the overnight park is a
 * `transition` out of the last leg with no next, non-revenue drives are
 * `loaded` on their (non-revenue) entry, which those readers already leave
 * out of revenue math. Drives the engine can't place (uncertain, outside
 * the window) are left unlinked rather than guessed.
 */

import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { LINK_RULES, linkTruck, otherTrucksAt, type DriveLink, type LegActual } from "./movementLinker.js";
import { loadOrgLinkInputs, wallClockToUtc } from "./movementLinkerData.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

export const LINK_SOURCE = "rule_v1";
const HOUR = 3_600_000;
const CHUNK = 500;

type Confidence = "high" | "medium" | "low";

interface LinkFact {
  role: "loaded" | "transition" | "dwell" | "rest" | "unrelated";
  loaded_event_id: string | null;
  from_event_id: string | null;
  to_event_id: string | null;
  dwell_stop_id: string | null;
  confidence: Confidence;
  reasoning: string;
}

interface CurrentLink extends Omit<LinkFact, "reasoning" | "confidence"> {
  id: string;
  movement_id: string;
  source: string;
  confidence: Confidence | null;
}

function toFact(d: DriveLink, confOf: (eventId: string | null) => Confidence): LinkFact | null {
  const base = { loaded_event_id: null, from_event_id: null, to_event_id: null, dwell_stop_id: null };
  const why = `${d.reason}${d.eventIds.length > 1 ? ` · miles split ${d.eventIds.length} ways` : ""}`;
  switch (d.role) {
    case "loaded":
    case "non_revenue":
      return d.eventId ? { ...base, role: "loaded", loaded_event_id: d.eventId, confidence: confOf(d.eventId), reasoning: why } : null;
    case "deadhead":
      return d.toEventId ? { ...base, role: "transition", from_event_id: d.fromEventId, to_event_id: d.toEventId, confidence: confOf(d.toEventId), reasoning: why } : null;
    case "return":
      return d.fromEventId ? { ...base, role: "transition", from_event_id: d.fromEventId, confidence: confOf(d.fromEventId), reasoning: why } : null;
    case "dwell":
      return d.eventId ? { ...base, role: "dwell", loaded_event_id: d.eventId, dwell_stop_id: d.stopId, confidence: confOf(d.eventId), reasoning: why } : null;
    case "rest":
    case "idle":
      return { ...base, role: "rest", confidence: "high", reasoning: why };
    case "unexplained":
      return { ...base, role: "unrelated", confidence: "medium", reasoning: why };
    default:
      return null; // uncertain, outside the window, GPS gap
  }
}

const sameFact = (a: CurrentLink, b: LinkFact) =>
  a.role === b.role && a.loaded_event_id === b.loaded_event_id && a.from_event_id === b.from_event_id
  && a.to_event_id === b.to_event_id && a.dwell_stop_id === b.dwell_stop_id && a.confidence === b.confidence;

export interface LinkRunResult {
  orgId: string;
  from: string;
  to: string;
  skipped?: string;
  trucks: number;
  drives: number;
  linksWritten: number;
  linksCleared: number;
  linksUnchanged: number;
  manualKept: number;
  legs: number;
  confidence: Record<Confidence, number>;
}

/**
 * Links `orgId`'s trucks for [from, to] (YYYY-MM-DD, org-local days).
 * Drives that ended less than `settleHours` ago are left for a later run —
 * Motive keeps editing the last few hours.
 */
export async function runMovementLinking(
  orgId: string,
  opts: {
    from: string;
    to: string;
    now?: number;
    settleHours?: number;
    dryRun?: boolean;
    /** Only these trucks (the timeline's "Re-link" buttons). */
    assetIds?: number[];
    /** Exact UTC window to write, inside [from, to] (ms). */
    utcWindow?: { from: number; to: number };
  },
): Promise<LinkRunResult> {
  const out: LinkRunResult = {
    orgId, from: opts.from, to: opts.to, trucks: 0, drives: 0,
    linksWritten: 0, linksCleared: 0, linksUnchanged: 0, manualKept: 0, legs: 0,
    confidence: { high: 0, medium: 0, low: 0 },
  };
  // leg_actuals arrives by migration; until it exists the job does nothing
  // so links and leg rows never get out of step.
  const probe = opts.dryRun ? { error: null } : await supabase.from("leg_actuals").select("event_id").limit(1);
  if (probe.error) return { ...out, skipped: `leg_actuals unavailable (${probe.error.message}) — run 20261016_leg_actuals.sql` };

  const now = opts.now ?? Date.now();
  const inputs = await loadOrgLinkInputs(orgId, opts.from, opts.to);
  const winFrom = opts.utcWindow?.from ?? wallClockToUtc(`${opts.from}T00:00`, inputs.timeZone) ?? 0;
  const winTo = Math.min(
    opts.utcWindow?.to ?? wallClockToUtc(`${opts.to}T23:59`, inputs.timeZone) ?? now,
    now - (opts.settleHours ?? 6) * HOUR,
  );

  // Every truck is aligned (the other-truck hints need the whole fleet's
  // GPS), but only the requested ones are written.
  const writeAsset = (id: number) => !opts.assetIds || opts.assetIds.includes(id);
  const runs = inputs.trucks.map((t) => ({ t, res: linkTruck({ drives: t.drives, events: t.events, homes: inputs.homes, rules: LINK_RULES }) }));
  const fleet = runs.map(({ t, res }) => ({ assetId: t.assetId, name: t.name, visits: res.visits }));
  out.trucks = runs.filter(({ t }) => writeAsset(t.assetId)).length;

  // ── Leg rows ──
  const legRows: Record<string, unknown>[] = [];
  const settledDrives: Array<{ d: DriveLink; confOf: (id: string | null) => Confidence }> = [];
  for (const { t, res } of runs) {
    if (!writeAsset(t.assetId)) continue;
    const legById = new Map<string, LegActual>(res.legs.map((l) => [l.eventId, l]));
    const confOf = (id: string | null): Confidence => (id && legById.get(id)?.confidence) || "medium";
    const noGps = !t.hasGps || t.drives.length === 0;
    for (const e of t.events) {
      if (e.start < winFrom || e.start > winTo) continue;
      const l = legById.get(e.id)!;
      const issues = noGps ? [...(l.issues.includes("no_stops") ? ["no_stops"] : []), "no_gps"] : l.issues;
      legRows.push({
        event_id: e.id,
        org_id: orgId,
        asset_id: t.assetId,
        load_id: e.loadId,
        source: LINK_SOURCE,
        confidence: noGps ? "low" : l.confidence,
        issues,
        route_miles: e.routeMiles,
        loaded_miles: round(l.loadedMiles), loaded_hours: round(l.loadedHours),
        deadhead_miles: round(l.deadheadMiles), deadhead_hours: round(l.deadheadHours),
        return_miles: round(l.returnMiles), return_hours: round(l.returnHours),
        dwell_hours: round(l.dwellHours), rest_hours: round(l.restHours),
        truck_start: l.truckStart != null ? new Date(l.truckStart).toISOString() : null,
        truck_end: l.truckEnd != null ? new Date(l.truckEnd).toISOString() : null,
        stops: l.stops.map((s) => ({
          stopId: s.stopId, kind: s.kind, label: s.label,
          arrive: iso(s.arrive), depart: iso(s.depart),
          distMi: round(s.distMi), offH: round(s.offH), issue: s.issue,
          nearest: s.nearest ? { distMi: round(s.nearest.distMi), offH: round(s.nearest.offH), at: iso(s.nearest.at) } : null,
          otherTrucks: s.issue === "stop_not_found" || s.issue === "stop_out_of_order"
            ? otherTrucksAt(s, fleet, t.assetId).map((o) => ({ assetId: o.assetId, name: o.name, arrive: iso(o.arrive) }))
            : [],
        })),
        computed_at: new Date(now).toISOString(),
      });
      out.confidence[(noGps ? "low" : l.confidence) as Confidence]++;
    }
    for (const d of res.drives) {
      if (d.start >= winFrom && d.end <= winTo) settledDrives.push({ d, confOf });
    }
  }
  out.legs = legRows.length;
  out.drives = settledDrives.length;

  // ── Links ──
  const ids = settledDrives.map((x) => x.d.driveId);
  const current = new Map<string, CurrentLink>();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const rows = await fetchAllRows<CurrentLink>("linker current links", () => supabase
      .from("movement_links")
      .select("id, movement_id, role, loaded_event_id, from_event_id, to_event_id, dwell_stop_id, source, confidence")
      .eq("org_id", orgId)
      .in("movement_id", chunk)
      .is("superseded_at", null));
    for (const r of rows) current.set(r.movement_id, r);
  }

  const inserts: Record<string, unknown>[] = [];
  const retire: string[] = [];
  for (const { d, confOf } of settledDrives) {
    const cur = current.get(d.driveId);
    if (cur?.source === "manual") { out.manualKept++; continue; }
    const fact = toFact(d, confOf);
    if (!fact) {
      // No longer placeable: withdraw our own earlier guess, leave others'.
      if (cur && cur.source === LINK_SOURCE) { retire.push(cur.id); out.linksCleared++; }
      else out.linksUnchanged++;
      continue;
    }
    if (cur && cur.source === LINK_SOURCE && sameFact(cur, fact)) { out.linksUnchanged++; continue; }
    inserts.push({ org_id: orgId, movement_id: d.driveId, source: LINK_SOURCE, source_user: null, ...fact });
    if (cur) retire.push(cur.id);
    out.linksWritten++;
  }
  if (opts.dryRun) return out;

  // New facts first, then retire the ones they replace, so a movement is
  // never left without its current link mid-run.
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const { error } = await supabase.from("movement_links").insert(inserts.slice(i, i + CHUNK));
    if (error) throw new Error(`movement_links insert: ${error.message}`);
  }
  const stamp = new Date(now).toISOString();
  for (let i = 0; i < retire.length; i += CHUNK) {
    const { error } = await supabase.from("movement_links")
      .update({ superseded_at: stamp })
      .in("id", retire.slice(i, i + CHUNK))
      .is("superseded_at", null);
    if (error) throw new Error(`movement_links supersede: ${error.message}`);
  }
  await dedupeCurrent(orgId, ids, stamp);
  for (let i = 0; i < legRows.length; i += CHUNK) {
    const { error } = await supabase.from("leg_actuals").upsert(legRows.slice(i, i + CHUNK), { onConflict: "event_id" });
    if (error) throw new Error(`leg_actuals upsert: ${error.message}`);
  }
  return out;
}

/**
 * A movement must have at most one current link. Two writers can race (a
 * "Re-link" click during the 6-hourly run), so after writing, keep only the
 * newest current link per movement — or the manual one, if a person set it
 * mid-run.
 */
async function dedupeCurrent(orgId: string, movementIds: string[], stamp: string): Promise<void> {
  const extra: string[] = [];
  for (let i = 0; i < movementIds.length; i += 150) {
    const rows = await fetchAllRows<{ id: string; movement_id: string; asserted_at: string; source: string }>("linker dedupe", () => supabase
      .from("movement_links")
      .select("id, movement_id, asserted_at, source")
      .eq("org_id", orgId)
      .in("movement_id", movementIds.slice(i, i + 150))
      .is("superseded_at", null));
    const byMovement = new Map<string, typeof rows>();
    for (const r of rows) byMovement.set(r.movement_id, [...(byMovement.get(r.movement_id) ?? []), r]);
    for (const list of byMovement.values()) {
      if (list.length < 2) continue;
      // A person's link always wins; otherwise the newest.
      list.sort((a, b) =>
        Number(b.source === "manual") - Number(a.source === "manual")
        || b.asserted_at.localeCompare(a.asserted_at) || b.id.localeCompare(a.id));
      extra.push(...list.slice(1).map((r) => r.id));
    }
  }
  for (let i = 0; i < extra.length; i += CHUNK) {
    const { error } = await supabase.from("movement_links")
      .update({ superseded_at: stamp })
      .in("id", extra.slice(i, i + CHUNK))
      .is("superseded_at", null);
    if (error) throw new Error(`movement_links dedupe: ${error.message}`);
  }
}

function round(n: number | null | undefined): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}
function iso(ms: number | null | undefined): string | null {
  return ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}
