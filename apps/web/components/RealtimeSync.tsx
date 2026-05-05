'use client';

/**
 * Subscribes to Supabase realtime for `events` row changes scoped to the
 * active org. On any INSERT/UPDATE/DELETE we refetch the affected event
 * via the Railway API (`getEvent`) and merge the joined Load shape into
 * the store. This keeps the web in sync with mobile dispatch writes
 * without converting the bare realtime payload (which lacks load-level
 * fields after the 2.5a/c split).
 *
 * Self-echo handling: writes from this same browser invalidate the local
 * loadedAt timestamp via the store's optimistic update path, so the
 * subsequent realtime callback simply reapplies the same data — harmless.
 */

import { useEffect } from 'react';
import { useOrganization } from '@clerk/nextjs';
import { getSupabase } from '@/lib/supabase';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function RealtimeSync() {
  const { organization } = useOrganization();
  const orgId = organization?.id ?? null;
  const updateFromRemote = useCalendarStore(s => s.updateEventFromRemote);
  const removeFromRemote = useCalendarStore(s => s.removeEventFromRemote);

  useEffect(() => {
    if (!orgId) return;
    const supabase = getSupabase();

    const refetchEvent = async (eventId: string) => {
      try {
        const { loads } = await railway.getEvent(eventId);
        for (const load of loads) updateFromRemote(load);
      } catch (err) {
        // 404 is fine — event was deleted between INSERT/UPDATE and our refetch.
        const status = (err as { status?: number } | undefined)?.status;
        if (status !== 404) console.warn('[realtime] refetch failed:', err);
      }
    };

    const channel = supabase
      .channel(`org-${orgId}-events`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'events', filter: `org_id=eq.${orgId}` },
        (payload) => {
          const id = (payload.new as { id?: string }).id;
          if (id) void refetchEvent(id);
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'events', filter: `org_id=eq.${orgId}` },
        (payload) => {
          const row = payload.new as { id?: string; deleted_at?: string | null };
          if (!row.id) return;
          // Soft-delete (deleted_at set) → drop locally.
          if (row.deleted_at) { removeFromRemote(row.id); return; }
          void refetchEvent(row.id);
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'events', filter: `org_id=eq.${orgId}` },
        (payload) => {
          const id = (payload.old as { id?: string }).id;
          if (id) removeFromRemote(id);
        },
      )
      .subscribe();

    // Stops table — when stops change we just refetch the parent event.
    const stopsChannel = supabase
      .channel(`org-${orgId}-stops`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'stops', filter: `org_id=eq.${orgId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as { event_id?: string };
          if (row?.event_id) void refetchEvent(row.event_id);
        },
      )
      .subscribe();

    // Loads table — load-level fields (accessorials, broker, load_price,
    // notes, internal_note, customer_id, …) live here and don't bump the
    // events row, so we need a separate channel. On change we refetch
    // every event in the local cache tied to that load_id.
    const loadsChannel = supabase
      .channel(`org-${orgId}-loads`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'loads', filter: `org_id=eq.${orgId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as { id?: string };
          if (!row?.id) return;
          const loadId = row.id;
          const events = useCalendarStore.getState().events;
          for (const ev of events) {
            if (ev.loadId === loadId) void refetchEvent(ev.id);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(stopsChannel);
      supabase.removeChannel(loadsChannel);
    };
  }, [orgId, updateFromRemote, removeFromRemote]);

  return null;
}
