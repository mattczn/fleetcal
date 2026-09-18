'use client';

import { useMemo, useState } from 'react';
import { Link2, Plus } from 'lucide-react';
import type { PlannedEvent } from '@fleetcal/types';
import type { CalendarEvent } from '@/lib/types';

/** How far around the plan's window the attach picker looks for loads
 *  on the same truck. Wide on purpose — a load often books a little
 *  earlier or later than the plan guessed. */
const ATTACH_WINDOW_DAYS = 3;
const ACCENT = '#475569';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  plan: PlannedEvent;
  events: CalendarEvent[];
  /** `loadId` is the load uuid (event.loadId), not the event id. */
  onAttach: (loadId: string) => void | Promise<void>;
  onCreateLoad: () => void;
}

/**
 * Shown in the event modal for an existing plan: close it against a
 * load already on this truck, or open a new load prefilled from it.
 */
export default function PlanToLoadSection({ plan, events, onAttach, onCreateLoad }: Props) {
  const [showAttach, setShowAttach] = useState(false);
  const [busy, setBusy] = useState(false);

  // Loads on the same truck around the plan's window, closest start
  // first. Revenue events with a load only; one row per load.
  const candidates = useMemo(() => {
    const lo = addDays(plan.start.slice(0, 10), -ATTACH_WINDOW_DAYS);
    const hi = addDays(plan.end.slice(0, 10), ATTACH_WINDOW_DAYS);
    const seen = new Set<string>();
    const planStart = Date.parse(plan.start);
    return events
      .filter((e) => e.assetId === plan.assetId && e.loadId && !e.deletedAt && e.eventKind !== 'non_revenue'
        && e.start.slice(0, 10) <= hi && e.end.slice(0, 10) >= lo)
      .filter((e) => { if (seen.has(e.loadId!)) return false; seen.add(e.loadId!); return true; })
      .sort((a, b) => Math.abs(Date.parse(a.start) - planStart) - Math.abs(Date.parse(b.start) - planStart));
  }, [plan, events]);

  const btnStyle = { border: `1px solid ${ACCENT}`, color: ACCENT, background: 'var(--gc-surface)' };

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
        Turn this plan into a load
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setShowAttach((v) => !v)} disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium" style={btnStyle}>
          <Link2 size={13} /> Attach existing load
        </button>
        <button type="button" onClick={onCreateLoad} disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium" style={btnStyle}>
          <Plus size={13} /> Create load from plan
        </button>
      </div>
      {showAttach && (
        candidates.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
            No loads on this truck within {ATTACH_WINDOW_DAYS} days of the plan.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {candidates.map((e) => (
              <button key={e.loadId} type="button" disabled={busy}
                onClick={async () => { setBusy(true); try { await onAttach(e.loadId!); } finally { setBusy(false); } }}
                className="text-left rounded-lg px-3 py-2 text-xs transition-colors"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
                onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={(ev) => (ev.currentTarget.style.background = 'var(--gc-surface)')}>
                <div className="font-semibold truncate">{e.title}</div>
                <div style={{ color: 'var(--gc-text-3)' }}>
                  {e.start.replace('T', ' ')} → {e.end.replace('T', ' ')}{e.loadNum ? ` · #${e.loadNum}` : ''}
                </div>
              </button>
            ))}
          </div>
        )
      )}
      {plan.createdByName && (
        <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Planned by {plan.createdByName}</div>
      )}
    </div>
  );
}
