/**
 * One-shot backfill: warm events.route_polyline (+ loaded_miles) for existing
 * loads so map views draw from the stored polyline immediately after deploy
 * instead of waiting for the first compute-on-read.
 *
 * Mirrors the server's compute-on-read logic (apps/api/src/lib/routeGeometry.ts):
 * for every event with >= 2 geocoded stops and no cached polyline, it calls
 * Mapbox Directions once (overview=simplified, geometries=polyline → precision-5,
 * Static-Maps-compatible), then writes route_polyline + route_stops_key +
 * loaded_miles. Idempotent — re-running only touches events still missing a
 * polyline (or whose stop signature changed).
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/backfill-route-polylines.ts            # dry-run (default)
 *   npx tsx src/scripts/backfill-route-polylines.ts --apply    # actually write
 *   npx tsx src/scripts/backfill-route-polylines.ts --org=ORG  # scope to one org
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and MAPBOX_TOKEN (or
 * NEXT_PUBLIC_MAPBOX_TOKEN) in env — same tokens the API server uses.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ORG_ARG = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAPBOX = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
if (!MAPBOX) {
  console.error("Missing MAPBOX_TOKEN (or NEXT_PUBLIC_MAPBOX_TOKEN) in env.");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

interface StopMini { lat: number | null; lng: number | null; sequence: number }
interface EventRow {
  id: string;
  org_id: string;
  route_polyline: string | null;
  route_stops_key: string | null;
  loaded_miles: number | null;
  stops: StopMini[] | null;
}

const PAGE = 500;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function coordsOf(stops: StopMini[]): { lat: number; lng: number }[] {
  return stops
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .filter((s): s is StopMini & { lat: number; lng: number } => s.lat != null && s.lng != null)
    .map(s => ({ lat: s.lat, lng: s.lng }));
}

function stopsKey(coords: { lat: number; lng: number }[]): string {
  return coords.map(c => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).join("|");
}

async function computeRoute(coords: { lat: number; lng: number }[]): Promise<{ polyline: string; miles: number } | null> {
  const path = coords.slice(0, 25).map(c => `${c.lng},${c.lat}`).join(";");
  const reqUrl =
    `https://api.mapbox.com/directions/v5/mapbox/driving/${path}` +
    `?access_token=${MAPBOX}&overview=simplified&geometries=polyline&steps=false`;
  try {
    const res = await fetch(reqUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { routes?: { geometry: string; distance: number }[] };
    const route = json.routes?.[0];
    if (!route) return null;
    return { polyline: route.geometry, miles: Math.round((route.distance / 1609.344) * 10) / 10 };
  } catch {
    return null;
  }
}

const tally = { scanned: 0, tooFewStops: 0, alreadyWarm: 0, computed: 0, mapboxFail: 0, errors: 0 };

async function main() {
  console.log(APPLY ? "▶  apply mode: writing changes" : "🔍 dry-run mode: no writes");
  if (ORG_ARG) console.log(`   scoped to org: ${ORG_ARG}`);
  console.log("");

  let offset = 0;
  while (true) {
    let q = supabase
      .from("events")
      .select("id,org_id,route_polyline,route_stops_key,loaded_miles,stops(lat,lng,sequence)")
      .is("route_polyline", null)
      .is("deleted_at", null)
      .range(offset, offset + PAGE - 1);
    if (ORG_ARG) q = q.eq("org_id", ORG_ARG);
    const { data, error } = await q;
    if (error) {
      console.error("Page fetch failed:", error);
      process.exit(2);
    }
    const rows = (data ?? []) as unknown as EventRow[];
    if (rows.length === 0) break;

    for (const ev of rows) {
      tally.scanned++;
      const coords = coordsOf(ev.stops ?? []);
      if (coords.length < 2) { tally.tooFewStops++; continue; }
      const key = stopsKey(coords);
      if (ev.route_polyline && ev.route_stops_key === key) { tally.alreadyWarm++; continue; }

      if (!APPLY) {
        tally.computed++;
        console.log(`  → ${ev.id} :: ${coords.length} stops`);
        continue;
      }

      const route = await computeRoute(coords);
      if (!route) { tally.mapboxFail++; console.error(`  ✗ ${ev.id}: mapbox failed`); continue; }

      const nextMiles = ev.loaded_miles != null && ev.loaded_miles > 0 ? ev.loaded_miles : route.miles;
      const { error: upErr } = await supabase
        .from("events")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ route_polyline: route.polyline, route_stops_key: key, loaded_miles: nextMiles } as any)
        .eq("id", ev.id)
        .is("route_polyline", null); // race guard — don't clobber a fresh compute-on-read
      if (upErr) { tally.errors++; console.error(`  ✗ ${ev.id}:`, upErr.message); continue; }
      tally.computed++;
      console.log(`  ✓ ${ev.id} :: ${route.miles} mi`);
      await sleep(120); // gentle on the Mapbox rate limit
    }

    offset += rows.length;
    if (rows.length < PAGE) break;
  }

  console.log("");
  console.log("── Summary ─────────────────────────────────────────────");
  console.log(`Scanned (no polyline):  ${tally.scanned}`);
  console.log(`${APPLY ? "Computed + written" : "Would compute"}:   ${tally.computed}`);
  console.log(`Too few geocoded stops: ${tally.tooFewStops}`);
  console.log(`Already warm (skipped): ${tally.alreadyWarm}`);
  console.log(`Mapbox failed:          ${tally.mapboxFail}`);
  console.log(`Write errors:           ${tally.errors}`);
  console.log("");
  if (!APPLY) console.log("(dry-run — re-run with --apply to actually write)");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(3);
});
