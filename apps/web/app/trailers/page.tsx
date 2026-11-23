'use client';

/**
 * /trailers — the trailer fleet as a page.
 *
 * Map of every Motive-linked trailer's last-known position, beside a
 * roster split Active / Idle / No GPS with each trailer's status, last
 * seen, reverse-geocoded location, and — for the ones in use — the
 * load, driver and truck they're attached to.
 *
 * Same component as the Container-icon popup in the calendar toolbar;
 * see TrailersView. DataLoader hydrates the calendar store (trailers +
 * events) that the roster reads, and EventModal is mounted so clicking
 * through to an in-use trailer's load can open it here rather than
 * bouncing to /calendar — the pattern /drivers and /accounting use.
 */

import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import TrailersView from '@/components/trailers/TrailersView';
import EventModal from '@/components/calendar/EventModal';

export default function TrailersPage() {
  return (
    <RequireCap cap="loads.view" module="trailers">
      <DataLoader />
      <TrailersView />
      <EventModal />
    </RequireCap>
  );
}
