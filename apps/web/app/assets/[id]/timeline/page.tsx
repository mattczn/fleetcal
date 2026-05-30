'use client';

/**
 * /assets/[id]/timeline — per-asset day view.
 *
 * Side-by-side hourly timeline:
 *   - Left column:  scheduled events (loads + non-revenue) with stops
 *   - Right column: actual movements (Motive ELD + manual + derived)
 *                   each with its current-truth link chip
 *
 * This is the read+linking surface for the source-agnostic asset
 * timeline (see PR 1 in 20260602_movements_and_movement_links.sql).
 * PR 2 (this) is read-only display; PR 3 adds editing of links,
 * AI auto-link, and manual movement creation.
 */

import { useParams } from 'next/navigation';
import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import AssetTimelineView from '@/components/timeline/AssetTimelineView';
import EventModal from '@/components/calendar/EventModal';

export default function AssetTimelinePage() {
  const params = useParams<{ id: string }>();
  const assetId = Number(params.id);

  return (
    <RequireCap cap="loads.view">
      <DataLoader />
      <AssetTimelineView assetId={assetId} />
      <EventModal />
    </RequireCap>
  );
}
