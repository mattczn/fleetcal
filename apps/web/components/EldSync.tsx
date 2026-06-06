'use client';

import { useEffect } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';

/**
 * Mounted once globally on the calendar shell. Kicks off the initial
 * Motive `/locations` fetch and re-polls every 10 min — the API route
 * itself caches for 10 min, so polling more often just hits the cache.
 *
 * Both this and CalendarHeader's "X min ago" pill read from the same
 * `eldLocations` slice in `useCalendarStore`; there is a single fetcher
 * (`refreshEldLocations`) so we never have two pollers racing each
 * other against the same endpoint.
 */
const POLL_MS = 10 * 60_000;

export default function EldSync() {
  const refresh = useCalendarStore(s => s.refreshEldLocations);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    return () => clearInterval(iv);
  }, [refresh]);

  return null;
}
