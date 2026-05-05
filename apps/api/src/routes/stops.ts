/**
 * /v1/stops/recent — recently-used facility / address combos for the org.
 *
 * Used by the dispatch app's stop picker as a third source of suggestions
 * alongside saved_locations and Google Places autocomplete.
 *
 * Query params:
 *   q     — required, min 1 char. Matched against facility_name OR address (ilike).
 *   limit — optional, default 8, capped at 50.
 */

import { Hono } from "hono";
import {
  type ListRecentStopsResponse,
  type RecentStop,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const stops = new Hono<{ Variables: AuthVariables }>();

interface StopsRow {
  facility_name: string | null;
  address:       string | null;
  city:          string | null;
  lat:           number | null;
  lng:           number | null;
  timezone:      string | null;
  created_at:    string;
}

stops.get("/recent", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const q     = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "8", 10) || 8, 1), 50);

  if (!q) {
    return c.json({ recentStops: [] } satisfies ListRecentStopsResponse);
  }

  // Escape PostgREST-special chars in the LIKE pattern.
  const safe = q.replace(/[%,()]/g, "\\$&");
  const pattern = `%${safe}%`;

  // Pull a generous batch then dedupe in memory — Supabase JS client doesn't
  // support DISTINCT/GROUP BY directly. 80 rows is plenty given typical
  // dispatcher autocomplete usage.
  const { data, error } = await supabase
    .from("stops")
    .select("facility_name,address,city,lat,lng,timezone,created_at")
    .eq("org_id", orgId)
    .or(`facility_name.ilike.${pattern},address.ilike.${pattern}`)
    .order("created_at", { ascending: false })
    .limit(80);

  if (error) {
    console.error("[GET /v1/stops/recent] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const seen = new Set<string>();
  const out: RecentStop[] = [];
  for (const r of ((data ?? []) as StopsRow[])) {
    const key = `${(r.facility_name ?? "").toLowerCase()}|${(r.address ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      facilityName: r.facility_name ?? undefined,
      address:      r.address       ?? undefined,
      city:         r.city          ?? undefined,
      lat:          r.lat           ?? undefined,
      lng:          r.lng           ?? undefined,
      timezone:     r.timezone      ?? undefined,
    });
    if (out.length >= limit) break;
  }

  return c.json({ recentStops: out } satisfies ListRecentStopsResponse);
});

export default stops;
