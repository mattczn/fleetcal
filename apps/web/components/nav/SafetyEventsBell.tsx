'use client';

/**
 * SafetyEventsBell — top-right bell in AppTopBar + CalendarToolbar.
 *
 * Now a single-click affordance: tap the bell → SafetyPanel opens.
 * No preview popover, no in-between drawer. The panel is the one and
 * only detail surface.
 *
 * Bell still polls every 60s for the unread `newCount` so the badge
 * stays fresh without opening the panel.
 *
 * Gating:
 *   • usePermissions().can('safety.access')
 *   • useModules().enabled('motive_integration')
 * If either is false the bell doesn't render. The server enforces the
 * same gates independently.
 */

import { useEffect, useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { railway } from '@/lib/railway';
import SafetyPanel from './SafetyPanel';

const POLL_MS = 60_000;

export default function SafetyEventsBell() {
  const { can } = usePermissions();
  const { enabled } = useModules();

  const gated = !can('safety.access') || !enabled('motive_integration');

  const [newCount, setNewCount]   = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);

  // Poll only for the badge count — nothing else. Uses status=new with
  // limit=1 because we don't care about the payload, just the newCount
  // field the endpoint returns alongside.
  const load = useMemo(() => async () => {
    if (gated) return;
    try {
      const r = await railway.listPerformanceEvents('new', 1);
      setNewCount(r.newCount);
    } catch (err) {
      // Non-fatal — the API 404s for orgs without the gate, we've
      // already blocked those via `gated`. Log and move on.
      console.warn('[SafetyEventsBell] load failed:', err);
    }
  }, [gated]);

  useEffect(() => {
    if (gated) return;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [gated, load]);

  if (gated) return null;

  return (
    <>
      <button
        type="button"
        aria-label={newCount > 0 ? `${newCount} new safety alerts` : 'Safety alerts'}
        onClick={() => setPanelOpen(true)}
        className="relative shrink-0 flex items-center justify-center"
        style={{
          width: 32, height: 32,
          borderRadius: 6,
          border: '1px solid var(--gc-border-light)',
          background: 'var(--gc-surface)',
          color: newCount > 0 ? 'var(--gc-red, #dc2626)' : 'var(--gc-text-2)',
          cursor: 'pointer',
          transition: 'background 120ms, border-color 120ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-bg)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-surface)'; }}
      >
        <Bell size={16} />
        {newCount > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -4, right: -4,
              minWidth: 16, height: 16,
              padding: '0 4px',
              borderRadius: 999,
              background: '#dc2626',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 0 2px var(--gc-surface)',
            }}
          >
            {newCount > 99 ? '99+' : newCount}
          </span>
        )}
      </button>

      {panelOpen && (
        <SafetyPanel onClose={() => { setPanelOpen(false); void load(); }} />
      )}
    </>
  );
}
