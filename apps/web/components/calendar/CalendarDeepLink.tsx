'use client';

/**
 * CalendarDeepLink — opens a specific event on the calendar from a URL.
 *
 *   /calendar?event=<eventId>[&date=YYYY-MM-DD]
 *
 * Used by the Gmail reconciliation extension's "open in FleetCal" link so
 * a matched load lands on its calendar event (the pickup leg for relays —
 * the bot search returns that leg's id). Fetches the event via getEvent
 * (which also returns its relay partner), merges it into the store so it's
 * present even if outside the loaded window, navigates to its date, and
 * opens the event modal.
 *
 * Runs once per mount. Renders nothing.
 */
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import { dayAtNoon } from '@/lib/time-utils';

export default function CalendarDeepLink() {
  const params = useSearchParams();
  const dbReady = useCalendarStore((s) => s.dbReady);
  const done = useRef(false);

  useEffect(() => {
    if (done.current || !dbReady) return;
    const eventId = params.get('event');
    if (!eventId) return;
    done.current = true;

    void (async () => {
      const store = useCalendarStore.getState();
      try {
        // Pull the event (+ its relay partner) in if we don't already
        // have it loaded — the deep link can target a load outside the
        // current window.
        if (!store.events.some((e) => e.id === eventId)) {
          const { loads } = await railway.getEvent(eventId);
          if (loads?.length) store.mergeEvents(loads);
        }
        const ev = useCalendarStore.getState().events.find((e) => e.id === eventId);
        const dateStr = params.get('date') || ev?.start?.slice(0, 10);
        if (dateStr) {
          const [y, m, d] = dateStr.split('-').map(Number);
          if (y && m && d) store.setCurrentDate(dayAtNoon(y, m - 1, d));
        }
        store.openEditModal(eventId);
      } catch (err) {
        console.warn('[calendar deep-link] failed to open event', eventId, err);
      }
    })();
  }, [dbReady, params]);

  return null;
}
