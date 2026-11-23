'use client';

/**
 * TrailersView — the /trailers page body.
 *
 * Deliberately thin: the map, the Active / Idle / No GPS roster, the
 * search and the 60s location poll all live in TrailerFleetMapPanel,
 * which the calendar toolbar still opens as a popup. This page renders
 * that same component with `embedded`, so the two can't drift — a fix
 * to the roster or the pins shows up in both places at once.
 *
 * What the page adds is the shell. `noPageScroll` is required, not
 * cosmetic: a Google map needs a parent of known height, and AppShell's
 * default `overflow-y: auto` main would leave it measuring zero.
 */

import { Container } from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import TrailerFleetMapPanel from '@/components/calendar/TrailerFleetMapPanel';

export default function TrailersView() {
  return (
    <AppShell title="Trailers" icon={Container} noPageScroll>
      <TrailerFleetMapPanel embedded />
    </AppShell>
  );
}
