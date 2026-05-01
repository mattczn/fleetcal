import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Subscribe to Postgres changes on `events` for this org.
 *
 * NOTE: filtering by `driver_id=eq.X` directly would drop UPDATE events when
 * the driver_id is changed *off* this driver (the new row no longer matches
 * the filter). So we filter by org and inspect both old + new payloads to
 * decide whether to invalidate.
 *
 * Requires Realtime to be enabled on the `events` table in Supabase
 * (Database → Replication → toggle `events` on, or
 *  ALTER PUBLICATION supabase_realtime ADD TABLE events).
 */
export function useLoadsRealtime(driverId: number | undefined, orgId: string | undefined) {
  const queryClient = useQueryClient();
  // Stable per-hook-instance suffix so multiple screens (Schedule + Loads) can each
  // subscribe without colliding on the same channel name.
  const instanceId = useRef(Math.random().toString(36).slice(2, 8));

  useEffect(() => {
    if (!driverId || !orgId) return;

    const channel = supabase
      .channel(`org-events-${orgId}-${driverId}-${instanceId.current}`)
      .on(
        "postgres_changes",
        {
          event:  "*",
          schema: "public",
          table:  "events",
          filter: `org_id=eq.${orgId}`,
        },
        (payload) => {
          const oldDriverId = (payload.old as { driver_id?: number | null } | null)?.driver_id ?? null;
          const newDriverId = (payload.new as { driver_id?: number | null } | null)?.driver_id ?? null;
          // Only react to changes that touch this driver — either the row
          // was assigned to us, or it was removed from us.
          if (oldDriverId !== driverId && newDriverId !== driverId) return;

          queryClient.invalidateQueries({ queryKey: ["loads", driverId] });
          const id =
            (payload.new as { id?: string } | null)?.id ??
            (payload.old as { id?: string } | null)?.id;
          if (id) queryClient.invalidateQueries({ queryKey: ["load", id] });
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [driverId, orgId, queryClient]);
}
