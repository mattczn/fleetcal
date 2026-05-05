/**
 * App-wide realtime sync for dispatch. Subscribes to Supabase realtime on
 * the active org's `events`, `stops`, and `loads` tables and invalidates
 * the relevant React Query keys when a row changes — so the calendar,
 * routes view, and load detail pick up writes from other devices (web
 * dashboard, other dispatchers, the driver app) without waiting for the
 * 5-minute staleTime to elapse.
 *
 * Self-echo: invalidations are idempotent — refetching after our own
 * write just hits the API once with the same data we just wrote, no
 * UX harm. The load-detail screen still uses its own `lastSelfSaveAt`
 * ref to suppress the "Updated by another dispatcher" toast.
 */
import { useEffect } from "react";
import { useOrganization } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export default function RealtimeSync() {
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const qc = useQueryClient();

  useEffect(() => {
    if (!orgId) return;

    const invalidateLoadLists = () => {
      qc.invalidateQueries({ queryKey: ["loads"] });
      qc.invalidateQueries({ queryKey: ["loads-in-transit-window"] });
    };
    const invalidateLoadDetail = (eventId: string | undefined) => {
      if (eventId) qc.invalidateQueries({ queryKey: ["load", eventId] });
    };

    const eventsCh = supabase
      .channel(`org-${orgId}-events-mobile`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "events", filter: `org_id=eq.${orgId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as { id?: string };
          invalidateLoadDetail(row?.id);
          invalidateLoadLists();
        },
      )
      .subscribe();

    const stopsCh = supabase
      .channel(`org-${orgId}-stops-mobile`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stops", filter: `org_id=eq.${orgId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as { event_id?: string };
          invalidateLoadDetail(row?.event_id);
          invalidateLoadLists();
        },
      )
      .subscribe();

    const loadsCh = supabase
      .channel(`org-${orgId}-loads-mobile`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "loads", filter: `org_id=eq.${orgId}` },
        () => {
          // Loads-row changes don't carry an event id directly; invalidate
          // the load-detail prefix wholesale so any open load screen tied
          // to this org refetches.
          qc.invalidateQueries({ queryKey: ["load"] });
          invalidateLoadLists();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(eventsCh);
      supabase.removeChannel(stopsCh);
      supabase.removeChannel(loadsCh);
    };
  }, [orgId, qc]);

  return null;
}
