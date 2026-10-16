'use client';

/**
 * /timeline/review — loads whose GPS doesn't line up with the calendar.
 * Rows open /timeline?assetId=…&date=…&event=… where the GPS check and
 * verdict buttons live. Same gate as the timeline.
 */

import { Suspense } from 'react';
import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import LinkReviewQueue from '@/components/timeline/LinkReviewQueue';

export default function LinkReviewPage() {
  return (
    <Suspense fallback={null}>
      <RequireCap cap="loads.view" module="performance">
        <DataLoader />
        <LinkReviewQueue />
      </RequireCap>
    </Suspense>
  );
}
