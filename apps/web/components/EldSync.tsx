'use client';

import { useEffect } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';
import type { EldLocation } from '@/store/useCalendarStore';

async function fetchEldLocations(): Promise<EldLocation[]> {
  try {
    const res = await fetch('/api/motive/locations');
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : (Array.isArray(body?.locations) ? body.locations : []);
  } catch {
    return [];
  }
}

export default function EldSync() {
  const setEldLocations = useCalendarStore(s => s.setEldLocations);

  useEffect(() => {
    fetchEldLocations().then(setEldLocations);
    const iv = setInterval(() => fetchEldLocations().then(setEldLocations), 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, [setEldLocations]);

  return null;
}
