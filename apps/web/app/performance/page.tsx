'use client';

/**
 * /performance — fleet-wide performance comparison hub.
 *
 * Two tabs (URL-driven via ?tab=):
 *   - Assets  — per-truck rollup: revenue, RPM, deadhead %, etc.
 *               Click a row → /timeline?assetId=X for the deep dive.
 *   - Drivers — per-driver scorecard (existing DriversView).
 *
 * Same PeriodSelector both tabs use, so switching tabs preserves the
 * window the user is looking at.
 */

import { Suspense } from 'react';
import DataLoader from '@/components/DataLoader';
import EventModal from '@/components/calendar/EventModal';
import RequireCap from '@/components/auth/RequireCap';
import PerformanceView from '@/components/performance/PerformanceView';

export default function PerformancePage() {
  return (
    <RequireCap cap="drivers.view" module="performance">
      <DataLoader />
      <Suspense fallback={null}>
        <PerformanceView />
      </Suspense>
      <EventModal />
    </RequireCap>
  );
}
