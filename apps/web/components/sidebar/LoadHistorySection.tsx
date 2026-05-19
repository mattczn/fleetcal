'use client';

/**
 * LoadHistorySection — reusable "what loads has this driver/asset run?"
 * panel for DriversModal + AssetsModal. Mirrors the In Progress / Upcoming
 * / Completed structure from BrokerProfileModal so dispatchers see the
 * same layout everywhere a load list rolls up under an entity.
 *
 * Behavior:
 *   • Search box across title + load_num + ref nums + customer name.
 *     Empty search → grouped sections; non-empty → flat filtered list.
 *   • Upcoming + Completed each clip to 10 rows by default with an
 *     "Show all (N)" / "Show less" toggle. In Progress always shows
 *     all (rare for there to be many at once).
 */

import { useMemo, useState } from 'react';
import { Search, Clock, Package } from 'lucide-react';
import type { CalendarEvent, Asset } from '@/lib/types';
import { useCalendarStore } from '@/store/useCalendarStore';
import { parseNaiveIsoInTz } from '@/lib/time-utils';

interface Props {
  loads:    CalendarEvent[];
  assets:   Asset[];
  onSelect: (eventId: string) => void;
  /** Heading above the section. Defaults to "Loads". */
  heading?: string;
  /** Empty-state subtitle. Defaults to a generic message. */
  emptyLabel?: string;
}

const STATUS_META: Record<string, { label: string; bg: string; color: string }> = {
  scheduled:  { label: 'Scheduled',  bg: '#f1f3f4', color: '#5f6368' },
  assigned:   { label: 'Assigned',   bg: '#ede9fe', color: '#5b21b6' },
  dispatched: { label: 'Dispatched', bg: '#e8f0fe', color: '#1558d6' },
  en_route:   { label: 'En Route',   bg: '#fef0e6', color: '#b85c00' },
  picked_up:  { label: 'Picked Up',  bg: '#f3e8fd', color: '#7627bb' },
  delivered:  { label: 'Delivered',  bg: '#e6f4ea', color: '#137333' },
  tonu:       { label: 'TONU',       bg: '#fef3c7', color: '#92400e' },
  cancelled:  { label: 'Cancelled',  bg: '#fce8e6', color: '#c5221f' },
  problem:    { label: 'Problem',    bg: '#fef0e6', color: '#b85c00' },
};

// Status filters interpret the naive ISO start/end in the org's
// dispatch timezone. `new Date(naive)` was wrong: it treats the
// naive ISO as the BROWSER's local tz, which mis-buckets every load
// whenever the dispatcher's browser tz differs from the dispatch tz
// (e.g. dispatcher in ET viewing MT-stored loads sees them as ended
// 2h before they actually do).
function isInProgress(ev: CalendarEvent, tz: string | undefined): boolean {
  const status = ev.status ?? 'scheduled';
  if (['delivered', 'cancelled', 'tonu'].includes(status)) return false;
  const start = parseNaiveIsoInTz(ev.start, tz);
  const end   = parseNaiveIsoInTz(ev.end,   tz);
  const now   = Date.now();
  return start <= now && end >= now - 24 * 60 * 60 * 1000; // 24h grace on the back end
}
function isUpcoming(ev: CalendarEvent, tz: string | undefined): boolean  {
  if (['delivered', 'cancelled', 'tonu'].includes(ev.status ?? '')) return false;
  return parseNaiveIsoInTz(ev.start, tz) > Date.now();
}
function isCompleted(ev: CalendarEvent, tz: string | undefined): boolean {
  return ['delivered', 'tonu', 'cancelled'].includes(ev.status ?? '')
      || parseNaiveIsoInTz(ev.end, tz) < Date.now() - 24 * 60 * 60 * 1000;
}

const ACCENT = '#1a73e8';

export default function LoadHistorySection({ loads, assets, onSelect, heading = 'Loads', emptyLabel = 'No loads yet' }: Props) {
  const [search,           setSearch]           = useState('');
  const [showAllUpcoming,  setShowAllUpcoming]  = useState(false);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const tz = useCalendarStore(s => s.calendarTimezone);

  const groups = useMemo(() => {
    const inProgress = loads.filter(ev => isInProgress(ev, tz)).sort((a, b) => a.start.localeCompare(b.start));
    const upcoming   = loads.filter(ev => isUpcoming(ev, tz)).sort((a, b) => a.start.localeCompare(b.start));
    const completed  = loads.filter(ev => isCompleted(ev, tz)).sort((a, b) => b.start.localeCompare(a.start));
    return { inProgress, upcoming, completed };
  }, [loads, tz]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return null;
    return loads.filter(ev => {
      const refs = (ev.refNums ?? []).map(r => `${r.label} ${r.value}`).join(' ');
      const hay  = `${ev.title} ${ev.loadNum ?? ''} ${ev.broker ?? ''} ${refs}`.toLowerCase();
      return hay.includes(q);
    }).sort((a, b) => b.start.localeCompare(a.start));
  }, [loads, search]);

  if (loads.length === 0) {
    return (
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest mb-3"
          style={{ color: 'var(--gc-text-3)' }}>
          {heading}
        </div>
        <div className="flex flex-col items-center gap-2 py-8 rounded-xl"
          style={{ border: '1px dashed var(--gc-border-light)' }}>
          <Clock size={22} style={{ color: 'var(--gc-text-3)', opacity: 0.45 }} />
          <span className="text-sm" style={{ color: 'var(--gc-text-3)' }}>{emptyLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header row — heading + search */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-[10px] font-bold uppercase tracking-widest"
          style={{ color: 'var(--gc-text-3)' }}>
          {heading}
        </div>
        <div className="flex-1 relative" style={{ maxWidth: 220 }}>
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--gc-text-3)' }} />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search load #, broker…"
            style={{
              width: '100%', paddingLeft: 28, paddingRight: 8,
              height: 30, borderRadius: 8, fontSize: 12,
              border: '1px solid var(--gc-border)',
              background: 'var(--gc-surface)',
              color: 'var(--gc-text-1)', outline: 'none', boxSizing: 'border-box',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          />
        </div>
      </div>

      {filtered !== null ? (
        filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 rounded-xl"
            style={{ border: '1px dashed var(--gc-border-light)' }}>
            <Package size={22} style={{ color: 'var(--gc-text-3)', opacity: 0.45 }} />
            <span className="text-sm" style={{ color: 'var(--gc-text-3)' }}>
              No loads matching &quot;{search}&quot;
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map(ev => <LoadRow key={ev.id} ev={ev} assets={assets} onSelect={onSelect} />)}
          </div>
        )
      ) : (
        <div className="space-y-5">
          {groups.inProgress.length > 0 && (
            <Section label="In Progress" count={groups.inProgress.length} color="#e37400" bg="#fef3e2">
              <div className="space-y-1.5">
                {groups.inProgress.map(ev => <LoadRow key={ev.id} ev={ev} assets={assets} onSelect={onSelect} />)}
              </div>
            </Section>
          )}
          {groups.upcoming.length > 0 && (
            <Section
              label="Upcoming"
              count={groups.upcoming.length}
              clip={showAllUpcoming ? undefined : 10}
              onToggleClip={() => setShowAllUpcoming(v => !v)}
              expanded={showAllUpcoming}
              color={ACCENT}
              bg="#e8f0fe">
              <div className="space-y-1.5">
                {(showAllUpcoming ? groups.upcoming : groups.upcoming.slice(0, 10)).map(ev => (
                  <LoadRow key={ev.id} ev={ev} assets={assets} onSelect={onSelect} />
                ))}
              </div>
            </Section>
          )}
          {groups.completed.length > 0 && (
            <Section
              label="Completed"
              count={groups.completed.length}
              clip={showAllCompleted ? undefined : 10}
              onToggleClip={() => setShowAllCompleted(v => !v)}
              expanded={showAllCompleted}
              color="#188038"
              bg="#e6f4ea">
              <div className="space-y-1.5">
                {(showAllCompleted ? groups.completed : groups.completed.slice(0, 10)).map(ev => (
                  <LoadRow key={ev.id} ev={ev} assets={assets} onSelect={onSelect} />
                ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Section({ label, count, clip, onToggleClip, expanded, color, bg, children }: {
  label: string;
  count: number;
  clip?: number;
  onToggleClip?: () => void;
  expanded?: boolean;
  color: string;
  bg: string;
  children: React.ReactNode;
}) {
  const overflow = clip != null && count > clip;
  const shown = expanded ? count : Math.min(clip ?? count, count);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-extrabold uppercase tracking-widest px-2 py-0.5 rounded"
          style={{ color, background: bg }}>
          {label} · {clip ? `${shown} of ${count}` : count}
        </span>
        {overflow && (
          <button type="button" onClick={onToggleClip}
            className="text-[11px] font-bold transition-colors"
            style={{ color, background: 'transparent', border: 'none', cursor: 'pointer' }}>
            {expanded ? 'Show less' : `Show all (${count})`}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function LoadRow({ ev, assets, onSelect }: {
  ev: CalendarEvent;
  assets: Asset[];
  onSelect: (eventId: string) => void;
}) {
  const asset = assets.find(a => a.id === ev.assetId);
  const [y, m, d] = ev.start.split('T')[0].split('-').map(Number);
  const dateStr = new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const sm = STATUS_META[ev.status ?? 'scheduled'] ?? STATUS_META.scheduled;
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-xl transition-colors"
      style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)', cursor: 'pointer' }}
      onClick={() => onSelect(ev.id)}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-bg)')}
    >
      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: asset?.color ?? '#9aa0a6' }} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
          {ev.title}
        </div>
        <div className="text-xs mt-0.5 flex items-center gap-2" style={{ color: 'var(--gc-text-3)' }}>
          <span>{dateStr}</span>
          {asset && <span>· {asset.name}</span>}
          {ev.loadNum && <span>· #{ev.loadNum}</span>}
        </div>
      </div>
      <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg shrink-0"
        style={{ color: sm.color, background: sm.bg }}>
        {sm.label}
      </span>
    </div>
  );
}
