/**
 * Primes the React Query cache with a 2-week window of loads + the
 * current Motive truck locations as soon as the user is signed in.
 *
 * One round-trip fetches loads spanning today−7d → today+7d, then we
 * group by day and seed each per-day cache entry under the same query
 * keys the calendar screen uses. This keeps offline browsing fast
 * without adding any new query shape.
 *
 * Truck locations are cached under their existing key with a tighter
 * staleTime — they go stale faster than load metadata, but a 1-hour
 * cache is still useful when the user goes offline mid-trip.
 */
import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useOrganization } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import type { Load } from "@fleetcal/types";
import { railway } from "@/lib/railway";
import { fetchMotiveLocations } from "@/lib/motive";

const WINDOW_BACK  = 7;
const WINDOW_FWD   = 7;

function pad(n: number): string { return String(n).padStart(2, "0"); }
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function shiftDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export default function CachePrefetcher() {
  const { isSignedIn, getToken } = useAuth();
  const { organization } = useOrganization();
  const orgId = organization?.id ?? null;
  const queryClient = useQueryClient();
  const lastPrefetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isSignedIn || !orgId) return;
    // Re-prefetch when the active org changes (and on first sign-in).
    if (lastPrefetchedFor.current === orgId) return;
    lastPrefetchedFor.current = orgId;

    let cancelled = false;

    void (async () => {
      try {
        const today    = new Date();
        const fromDate = shiftDays(today, -WINDOW_BACK);
        const toDate   = shiftDays(today,  WINDOW_FWD);

        // Range fetch: one round-trip primes the whole window.
        const { loads } = await railway.listLoads({
          from: `${dateKey(fromDate)}T00:00`,
          to:   `${dateKey(toDate)}T23:59`,
        });
        if (cancelled) return;

        // Group by day and seed each per-day cache entry. The calendar
        // screen uses queryKey ["loads", orgId, dateKey].
        const byDay = new Map<string, Load[]>();
        for (let i = -WINDOW_BACK; i <= WINDOW_FWD; i++) {
          byDay.set(dateKey(shiftDays(today, i)), []);
        }
        for (const l of loads) {
          // A load occupies every day its [start, end] window touches.
          const startDay = l.start.slice(0, 10);
          const endDay   = (l.end ?? l.start).slice(0, 10);
          // Walk start → end inclusive.
          let cursor = new Date(`${startDay}T00:00`);
          const stop = new Date(`${endDay}T00:00`);
          while (cursor <= stop) {
            const key = dateKey(cursor);
            const list = byDay.get(key);
            if (list) list.push(l);
            cursor = shiftDays(cursor, 1);
          }
        }
        for (const [key, list] of byDay) {
          queryClient.setQueryData(["loads", orgId, key], list);
        }

        // Truck locations — fire-and-forget; one fetch under the existing key.
        void queryClient.prefetchQuery({
          queryKey: ["motive-locations", orgId],
          queryFn:  () => fetchMotiveLocations(getToken),
          staleTime: 60 * 60_000, // 1h — UI still revalidates on focus
        });
      } catch (err) {
        // Silent — prefetch failure isn't user-facing. Real reads still
        // happen on demand and will surface their own errors.
        console.warn("[CachePrefetcher]", err);
      }
    })();

    return () => { cancelled = true; };
  }, [isSignedIn, orgId, queryClient, getToken]);

  return null;
}
