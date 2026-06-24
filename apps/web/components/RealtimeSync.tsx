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

  // Keep the realtime socket authenticated. With Clerk third-party auth
  // there is no Supabase Auth session, so supabase-js never pushes the JWT
  // to the realtime socket on its own — under the RLS lockdown (landed
  // 2026-06-09) the socket then authorizes as `anon` and every row change
  // is filtered out, so confirmed / POD / status updates never reach the
  // calendar until a manual refresh (which goes through the service-role
  // API). Push a fresh Clerk 'supabase' token now and refresh it before
  // the ~60s token TTL so the socket stays `authenticated` with the
  // org_id claim the RLS policies check.
  useEffect(() => {
    if (!orgId) return;
    const supabase = getSupabase();
    let active = true;
    const pump = async () => {
      try {
        const token = await window.Clerk?.session?.getToken({ template: 'supabase' });
        if (active && token) await supabase.realtime.setAuth(token);
      } catch (err) {
        console.warn('[realtime] auth token pump failed:', err);
      }
    };
    void pump();
    const interval = setInterval(() => { void pump(); }, 50_000);
    return () => { active = false; clearInterval(interval); };
  }, [orgId]);

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

    // load_documents — POD uploads / deletes change documentCounts on
    // the joined Load shape, which drives the green doc-icon overlay
    // on the calendar card. Same pattern as loads: refetch every event
    // tied to the changed load_id.
    const docsChannel = supabase
      .channel(`org-${orgId}-load-documents`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'load_documents', filter: `org_id=eq.${orgId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as { load_id?: string | null };
          if (!row?.load_id) return;
          const loadId = row.load_id;
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
      supabase.removeChannel(docsChannel);
    };
  }, [orgId, updateFromRemote, removeFromRemote]);

  return null;
}
