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
import { useCalendarStore, type BatchItem } from '@/store/useCalendarStore';
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

  // Start a new load from a rate-con PDF handed over by the extension —
  // runs the same AI parse + opens the batch review modal the in-app
  // "drop a rate-con" flow uses (AssetSidebar.handleBatchFiles), so the
  // user reviews + creates in the normal UI.
  const createFromPdf = useCallback(async (base64: string) => {
    const store = useCalendarStore.getState();
    const dataUrl = `data:application/pdf;base64,${base64}`;
    let parsed: Record<string, unknown> = {};
    try {
      const res = await fetch('/api/parse-ratecon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: base64,
          enabledFields: Object.keys(store.fieldSettings || {}).filter((k) => store.fieldSettings[k]),
          customInstructions: store.promptInstructions,
          promptVariables: store.promptVariables,
          customers: store.customers.map((c) => ({ name: c.name, aliases: c.aliases ?? [], parseHints: c.parseHints })),
        }),
      });
      const json = await res.json();
      parsed = json && !json.error ? json : {};
    } catch { parsed = {}; }
    const item: BatchItem = { rateConPdf: dataUrl, parsed };
    store.startBatch([item]);
    store.openCreateModal();
  }, []);

  // Path 2 — messages from the extension bridge (no reload).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;           // same-origin only
      const d = e.data;
      if (!d || d.source !== 'fleetcal-ext') return;
      if (d.type === 'openEvent' && d.eventId) {
        void openEvent(String(d.eventId), d.date ? String(d.date) : null);
      } else if (d.type === 'createFromPdf' && d.pdfBase64) {
        void createFromPdf(String(d.pdfBase64));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [openEvent, createFromPdf]);

  return null;
}
