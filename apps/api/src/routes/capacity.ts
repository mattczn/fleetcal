/**
 * /v1/capacity — public 7-day rolling capacity window for broker websites.
 *
 * Mirrors the shape the old my-calendar /api/capacity endpoint produced
 * (consumed by curzontrucking.com /capacity), now sourced from fleetcal
 * events + assets. Public, optional API-key gated via CAPACITY_API_KEY.
 *
 * Booked = distinct asset_ids with at least one active (non-deleted)
 * event overlapping that day in org TZ. Mirrors the old "rid set" logic.
 * Non-revenue events (maintenance, OOS, etc.) still count as booked —
 * if the truck isn't moving freight that day, capacity for a new load is
 * gone regardless of why.
 *
 * loads_last_7_days counts revenue events with status in (delivered,
 * released, tonu) whose `end` falls in the past 7 days, dedup'd by
 * relay_group_id so a two-leg relay = 1 load. TONUs count because
 * the broker paid a flat fee — that's revenue even though the load
 * never moved.
 *
 * org_id defaults to Curzon Trucking prod; pass ?org_id=… to override.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const capacity = new Hono();

const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday",
] as const;

const DEFAULT_ORG_ID = "org_3Ck09w6LuEjiX4WgxJEPyiyjuXN"; // Curzon Trucking prod
const TZ = "America/Denver";

/** Today as a YYYY-MM-DD string in the given IANA timezone. */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** Add N days to a YYYY-MM-DD string (UTC-anchored, safe across DST). */
function addDays(dayStr: string, n: number): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** weekday index for a YYYY-MM-DD, Monday=0…Sunday=6. */
function weekdayMonFirst(dayStr: string): number {
  const dow = new Date(`${dayStr}T00:00:00Z`).getUTCDay(); // Sun=0..Sat=6
  return (dow + 6) % 7;
}

capacity.get("/", async (c) => {
  // Optional API key gate — matches the old my-calendar behavior. When
  // CAPACITY_API_KEY is unset the endpoint is fully open (aggregate
  // data only, no PII).
  const requiredKey = process.env.CAPACITY_API_KEY || "";
  if (requiredKey) {
    const provided = c.req.query("key");
    if (provided !== requiredKey) {
      return c.json({ error: "invalid key" }, 401);
    }
  }

  const orgId = c.req.query("org_id") || DEFAULT_ORG_ID;

  try {
    const today  = todayInTz(TZ);
    const days   = Array.from({ length: 7 }, (_, i) => addDays(today, i));
    const winStartNaive = `${days[0]}T00:00`;
    const winEndNaive   = `${addDays(days[6], 1)}T00:00`; // exclusive end

    // ── Total fleet size: non-hidden, non-Unassigned, currently active assets ─
    const { data: assetRows } = await sb
      .from("assets")
      .select("id")
      .eq("org_id", orgId)
      .eq("hidden", false)
      .neq("type", "Unassigned")
      .neq("name", "Unassigned")
      .or(`active_to.is.null,active_to.gte.${today}`);
    const totalDrivers = (assetRows ?? []).length;

    // ── Forward 7-day events ─────────────────────────────────────────────
    const { data: futureRows } = await sb
      .from("events")
      .select("asset_id, start, \"end\"")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .lt("start", winEndNaive)
      .gt("end", winStartNaive);
    const futureEvents = ((futureRows ?? []) as Array<{
      asset_id: number; start: string; end: string;
    }>);

    const resultDays = days.map((dayStr) => {
      const dayStart = `${dayStr}T00:00`;
      const dayEnd   = `${addDays(dayStr, 1)}T00:00`;

      const activeAssets = new Set<number>();
      for (const ev of futureEvents) {
        const s = (ev.start ?? "").slice(0, 16);
        const e = (ev.end   ?? "").slice(0, 16);
        if (s && e && s < dayEnd && e > dayStart) {
          activeAssets.add(ev.asset_id);
        }
      }

      const booked    = activeAssets.size;
      const available = Math.max(0, totalDrivers - booked);
      const pct       = totalDrivers > 0
        ? Math.round((booked / totalDrivers) * 100)
        : 0;

      return {
        date:      dayStr,
        day:       DAY_NAMES[weekdayMonFirst(dayStr)],
        booked,
        available,
        total:     totalDrivers,
        pct,
      };
    });

    // ── Loads completed in the past 7 days ───────────────────────────────
    // Window: today + 6 prior days = exactly 7 calendar days, in org TZ.
    // Status filter: only loads that actually shipped — delivered, released
    // (delivered + paperwork closed), or tonu (broker cancelled but paid a
    // flat fee, which is still revenue). Excludes cancelled, scheduled,
    // confirmed, in_transit so the marketing number reflects deliveries
    // that actually happened, not anything with an `end` in the past.
    const pastStartNaive = `${addDays(today, -6)}T00:00`;
    const pastEndNaive   = `${today}T23:59`;
    const { data: pastRows } = await sb
      .from("events")
      .select("id, relay_group_id, event_kind")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .in("status", ["delivered", "released", "tonu"])
      .gte("end", pastStartNaive)
      .lte("end", pastEndNaive);
    const pastEvents = ((pastRows ?? []) as Array<{
      id: string; relay_group_id: string | null; event_kind: string | null;
    }>);

    const seenGroups = new Set<string>();
    let loadsLast7 = 0;
    for (const ev of pastEvents) {
      // Marketing stat: revenue legs only. Non-revenue events (maintenance,
      // OOS) still take a truck off capacity but aren't "loads delivered".
      if (ev.event_kind === "non_revenue") continue;
      if (ev.relay_group_id) {
        if (!seenGroups.has(ev.relay_group_id)) {
          seenGroups.add(ev.relay_group_id);
          loadsLast7 += 1;
        }
      } else {
        loadsLast7 += 1;
      }
    }

    return c.json({
      total_drivers:     totalDrivers,
      loads_last_7_days: loadsLast7,
      generated_at:      new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      days:              resultDays,
    });
  } catch (err) {
    console.error("[capacity] error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

export default capacity;
