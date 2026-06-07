'use client';

/**
 * /timeline?assetId=… — per-truck activity view.
 *
 * Single endpoint with a truck filter. Coming from the calendar or
 * AssetDetailModal pre-fills the truck via the ?assetId query param;
 * the truck picker at the top lets the dispatcher switch within the
 * page without going back.
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import AssetTimelineView from '@/components/timeline/AssetTimelineView';
import EventModal from '@/components/calendar/EventModal';

function TimelinePageInner() {
  const searchParams = useSearchParams();
  const param = searchParams.get('assetId');
  const assetId = param ? Number(param) : null;

  return (
    // Gated on `performance` because the timeline is the deep-dive
    // surface the Performance hub links into (/performance → click
    // an asset row → /timeline?assetId=…). Orgs without the
    // performance module shouldn't be able to reach it via direct
    // URL or via the AssetDetailModal link.
    <RequireCap cap="loads.view" module="performance">
      <DataLoader />
      <AssetTimelineView assetId={Number.isFinite(assetId) ? assetId : null} />
      <EventModal />
    </RequireCap>
  );
}

// useSearchParams requires a Suspense boundary in Next 14+.
export default function TimelinePage() {
  return (
    <Suspense fallback={null}>
      <TimelinePageInner />
    </Suspense>
  );
}
