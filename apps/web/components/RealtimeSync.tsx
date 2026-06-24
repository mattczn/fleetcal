'use client';

/**
 * Subscribes to Supabase realtime for `events` / `stops` / `loads` /
 * `load_documents` row changes scoped to the active org. On any change we
 * refetch the affected event via the Railway API (`getEvent`) and merge the
 * joined Load shape into the store. This keeps the web in sync with mobile
 * dispatch writes without converting the bare realtime payload (which lacks
 * load-level fields after the 2.5a/c split).
 *
 * Realtime auth (RLS lockdown, landed 2026-06-09): the org-scoped RLS
 * policies only grant the `authenticated` role via the Clerk JWT's `org_id`
 * claim. With Clerk third-party auth there is no Supabase Auth session, so
 * supabase-js never authenticates the realtime SOCKET on its own — and
 * crucially, `postgres_changes` RLS is evaluated when a channel JOINS, so a
 * channel that subscribes before the socket has a token stays `anon`
 * (every row filtered out) even if we setAuth afterwards. So we must AWAIT
 * `setAuth(clerkToken)` BEFORE subscribing, then refresh the token ahead of
 * the ~60s Clerk TTL to keep the socket authorized. Without this, confirmed
 * / POD / status updates never reach the calendar until a manual refresh
 * (which goes through the service-role API and bypasses RLS).
 *
 * Self-echo handling: writes from this same browser invalidate the local
 * loadedAt timestamp via the store's optimistic update path, so the
 * subsequent realtime callback simply reapplies the same data — harmless.
 */

import { useEffect } from 'react';
import { useOrganization } from '@clerk/nextjs';
import type { RealtimeChannel } from '@supabase/supabase-js';
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
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    const channels: RealtimeChannel[] = [];

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

    // Push the current Clerk 'supabase' JWT to the realtime socket so the
    // org-scoped RLS policies grant `authenticated`. Returns the token so
    // the initial call can confirm we actually authed before subscribing.
    const applyRealtimeToken = async (): Promise<string | null> => {
      const token = (await window.Clerk?.session?.getToken({ template: 'supabase' })) ?? null;
      if (token) await supabase.realtime.setAuth(token);
      return token;
    };

    const onSubStatus = (label: string) => (status: string) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn(`[realtime] ${label} channel status: ${status}`);
      }
    };

    (async () => {
      // Authorize the socket BEFORE joining any channel — postgres_changes
      // RLS is evaluated at join time, so subscribing first would bind the
      // channels as `anon` and they'd never recover from a later setAuth.
      const token = await applyRealtimeToken();
      if (cancelled) return;
      if (!token) {
        console.warn('[realtime] no Clerk token available — realtime updates will be blocked by RLS');
      }
      // Keep the socket token fresh ahead of the ~60s Clerk TTL.
      refreshTimer = setInterval(() => { void applyRealtimeToken(); }, 50_000);

      channels.push(
        supabase
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
          .subscribe(onSubStatus('events')),
      );

      // Stops table — when stops change we just refetch the parent event.
      channels.push(
        supabase
          .channel(`org-${orgId}-stops`)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'stops', filter: `org_id=eq.${orgId}` },
            (payload) => {
              const row = (payload.new ?? payload.old) as { event_id?: string };
              if (row?.event_id) void refetchEvent(row.event_id);
            },
          )
          .subscribe(onSubStatus('stops')),
      );

      // Loads table — load-level fields (accessorials, broker, load_price,
      // notes, internal_note, customer_id, …) live here and don't bump the
      // events row, so we need a separate channel. On change we refetch
      // every event in the local cache tied to that load_id.
      channels.push(
        supabase
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
          .subscribe(onSubStatus('loads')),
      );

      // load_documents — POD uploads / deletes change documentCounts on
      // the joined Load shape, which drives the green doc-icon overlay
      // on the calendar card. Same pattern as loads: refetch every event
      // tied to the changed load_id.
      channels.push(
        supabase
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
          .subscribe(onSubStatus('load-documents')),
      );
    })();

    return () => {
      cancelled = true;
      if (refreshTimer) clearInterval(refreshTimer);
      for (const ch of channels) supabase.removeChannel(ch);
    };
  }, [orgId, updateFromRemote, removeFromRemote]);

  return null;
}
