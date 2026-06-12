'use client';

/**
 * CalendarDeepLink — opens a specific event on the calendar, two ways:
 *
 *   1. URL params  /calendar?event=<id>[&date=YYYY-MM-DD]  — used on a fresh
 *      tab / full load (the Gmail extension's fallback when no FleetCal tab
 *      is open).
 *   2. window postMessage { source:'fleetcal-ext', type:'openEvent', eventId,
 *      date } — used when a FleetCal tab is ALREADY open. The extension's
 *      content-script bridge posts this so we open the event in-place via the
 *      store, with NO full page reload.
 *
 * Both paths run the same openEvent(): fetch the event (+ its relay partner)
 * via getEvent, merge it into the store so it's present even outside the
 * loaded window, navigate to its date, and open the event modal.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import { dayAtNoon } from '@/lib/time-utils';

export default function CalendarDeepLink() {
  const params = useSearchParams();
  const dbReady = useCalendarStore((s) => s.dbReady);
  const urlDone = useRef(false);

  const openEvent = useCallback(async (eventId: string, dateHint?: string | null) => {
    if (!eventId) return;
    const store = useCalendarStore.getState();
    try {
      if (!store.events.some((e) => e.id === eventId)) {
        const { loads } = await railway.getEvent(eventId);
        if (loads?.length) store.mergeEvents(loads);
      }
      const ev = useCalendarStore.getState().events.find((e) => e.id === eventId);
      const dateStr = dateHint || ev?.start?.slice(0, 10);
      if (dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        if (y && m && d) store.setCurrentDate(dayAtNoon(y, m - 1, d));
      }
      store.openEditModal(eventId);
    } catch (err) {
      console.warn('[calendar deep-link] failed to open event', eventId, err);
    }
  }, []);

  // Path 1 — URL params (fresh load). Runs once.
  useEffect(() => {
    if (urlDone.current || !dbReady) return;
    const eventId = params.get('event');
    if (!eventId) return;
    urlDone.current = true;
    void openEvent(eventId, params.get('date'));
  }, [dbReady, params, openEvent]);

  // Path 2 — in-place open from the extension bridge (no reload).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;           // same-origin only
      const d = e.data;
      if (!d || d.source !== 'fleetcal-ext' || d.type !== 'openEvent' || !d.eventId) return;
      void openEvent(String(d.eventId), d.date ? String(d.date) : null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [openEvent]);

  return null;
}
