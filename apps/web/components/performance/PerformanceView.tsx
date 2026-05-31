'use client';

/**
 * Performance hub — currently just the per-asset comparison view.
 *
 * DriversView wraps its own AppShell so it can't cleanly nest inside
 * here as a tab. For now /drivers stays its own route; we link to it
 * from a header switch. If DriversView later gets split into a
 * presentational form we can promote both into proper tabs.
 */

import AssetPerformanceView from './AssetPerformanceView';

export default function PerformanceView() {
  return <AssetPerformanceView />;
}
