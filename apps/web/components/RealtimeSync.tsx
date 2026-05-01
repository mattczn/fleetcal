'use client';

import { useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';
import { getSupabase, dbEventToApp } from '@/lib/supabase';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function RealtimeSync() {
  const { orgId } = useAuth();

  useEffect(() => {
    if (!orgId) return;

    const supabase = getSupabase();

    const channel = supabase
      .channel(`events-${orgId}`)
      .on(
        'postgres_changes',
        // No server-side filter — filter client-side to avoid REPLICA IDENTITY issues
        { event: '*', schema: 'public', table: 'events' },
        (payload) => {
          // Ignore rows from other orgs
          const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as Record<string, unknown>;
          if (!row || row.org_id !== orgId) return;

          const { addEventFromRemote, updateEventFromRemote, removeEventFromRemote } = useCalendarStore.getState();

          try {
            if (payload.eventType === 'INSERT') {
              addEventFromRemote(dbEventToApp(payload.new as unknown as Parameters<typeof dbEventToApp>[0]));
            } else if (payload.eventType === 'UPDATE') {
              const newRow = payload.new as Record<string, unknown>;
              // Soft delete — deleted_at was set
              if (newRow.deleted_at) {
                removeEventFromRemote(newRow.id as string);
              } else {
                updateEventFromRemote(dbEventToApp(newRow as unknown as Parameters<typeof dbEventToApp>[0]));
              }
            } else if (payload.eventType === 'DELETE') {
              removeEventFromRemote((payload.old as { id: string }).id);
            }
          } catch (err) {
            console.error('[RealtimeSync] error processing payload:', err, payload);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [orgId]);

  return null;
}
