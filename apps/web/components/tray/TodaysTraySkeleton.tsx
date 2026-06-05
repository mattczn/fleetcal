'use client';

import { Layers, LayoutDashboard, ChevronUp } from 'lucide-react';
import { useModules } from '@/lib/useModules';

/**
 * Bottom-tray placeholder shown while initial data is loading. Mirrors the
 * collapsed TodaysTray header bar (blue, fixed bottom, 48px tall) with a
 * shimmer block where the load count + filter chips would go.
 */
export default function TodaysTraySkeleton() {
  const { enabled: moduleEnabled } = useModules();
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 flex flex-col"
      style={{ background: 'var(--gc-surface)', borderTop: '1px solid var(--gc-border)', boxShadow: '0 -2px 8px rgba(0,0,0,.08)', overflow: 'hidden' }}
    >
      <div className="flex items-center gap-3 px-5"
        style={{ height: 48, paddingBottom: 8, background: '#1a73e8' }}>
        <Layers size={15} style={{ color: 'rgba(255,255,255,0.8)', flexShrink: 0 }} />
        <span className="text-sm font-semibold" style={{ color: '#fff' }}>Today's Loads</span>
        <div className="skeleton-pulse-blue rounded-full" style={{ width: 36, height: 18 }} />
        <div className="skeleton-pulse-blue rounded-full" style={{ width: 86, height: 18 }} />
        <div className="flex-1" />
        {moduleEnabled('dispatch_board') && (
          <div
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg shrink-0"
            style={{ background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.65)', border: '1px solid rgba(255,255,255,0.3)' }}
          >
            <LayoutDashboard size={12} />
            Command Center
          </div>
        )}
        <ChevronUp size={16} style={{ color: 'rgba(255,255,255,0.8)', flexShrink: 0 }} />
      </div>
    </div>
  );
}
