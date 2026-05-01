'use client';

import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Zap, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { scoreAssetsForLoad, AssetMatch } from '@/lib/scoring';
import { localDateStr } from '@/lib/time-utils';

function fmtTime(iso: string) {
  const t = iso.split('T')[1]?.slice(0, 5);
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')}${ampm}`;
}

function fmtMiles(n: number | null) {
  if (n === null) return null;
  return `${n}mi`;
}

function fmtGap(mins: number | null) {
  if (mins === null) return null;
  if (mins < 60) return `${mins}m gap`;
  return `${Math.floor(mins / 60)}h${mins % 60 ? `${mins % 60}m` : ''} gap`;
}

function ScoreBar({ score, conflict }: { score: number; conflict: boolean }) {
  const color = conflict ? '#ef4444' : score >= 75 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 48, height: 4, borderRadius: 2, background: 'var(--gc-border)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${conflict ? 100 : score}%`, background: color, borderRadius: 2, transition: 'width 300ms' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 26 }}>{conflict ? '—' : score}</span>
    </div>
  );
}

// Mini 24h timeline strip for one asset
function MiniTimeline({ match, load }: { match: AssetMatch; load: { start: string; end: string } }) {
  const { events } = useCalendarStore();
  const assetEvents = events.filter(e => e.assetId === match.asset.id);
  const dateStr = load.start.split('T')[0];

  function toFrac(iso: string): number {
    const t = iso.split('T')[1];
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return Math.min(1, (h * 60 + m) / (24 * 60));
  }

  const loadStartFrac = toFrac(load.start);
  const loadEndFrac   = toFrac(load.end);

  return (
    <div style={{ position: 'relative', height: 8, background: 'var(--gc-border)', borderRadius: 4, overflow: 'hidden', flex: 1 }}>
      {/* existing events */}
      {assetEvents.map(e => {
        const eDate = e.start.split('T')[0];
        if (eDate !== dateStr && e.end.split('T')[0] !== dateStr) return null;
        const left = toFrac(eDate < dateStr ? `${dateStr}T00:00` : e.start);
        const right = toFrac(e.end.split('T')[0] > dateStr ? `${dateStr}T23:59` : e.end);
        if (right <= left) return null;
        return (
          <div key={e.id} style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${left * 100}%`, width: `${(right - left) * 100}%`,
            background: match.asset.color, opacity: 0.7,
          }} />
        );
      })}
      {/* load slot */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0,
        left: `${loadStartFrac * 100}%`,
        width: `${Math.max(0.02, loadEndFrac - loadStartFrac) * 100}%`,
        background: match.hasConflict ? '#ef4444' : '#3b82f6',
        opacity: 0.9,
        borderRadius: 2,
      }} />
    </div>
  );
}

function MatchRow({ match, load, onAssign }: {
  match: AssetMatch;
  load: { start: string; end: string; assetId: number };
  onAssign: (assetId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      borderRadius: 8,
      border: `1px solid ${match.hasConflict ? '#fca5a5' : 'var(--gc-border)'}`,
      background: match.hasConflict ? '#fff5f5' : 'var(--gc-surface)',
      overflow: 'hidden',
      opacity: match.hasConflict ? 0.7 : 1,
    }}>
      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Color dot + name */}
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: match.asset.color, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gc-text-1)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {match.asset.name}
            {match.asset.unit ? <span style={{ color: 'var(--gc-text-3)', fontWeight: 400, marginLeft: 4 }}>#{match.asset.unit}</span> : null}
          </div>
          <div style={{ marginTop: 4 }}>
            <MiniTimeline match={match} load={load} />
          </div>
        </div>

        {/* Score */}
        <ScoreBar score={match.score} conflict={match.hasConflict} />

        {/* Expand toggle */}
        <button type="button" onClick={() => setExpanded(x => !x)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-3)', padding: 2, display: 'flex' }}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {/* Assign button — always shown; amber + warning label when conflicting */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
          {match.hasConflict && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#d97706', fontSize: 10, fontWeight: 600 }}>
              <AlertTriangle size={10} /> Overlap
            </div>
          )}
          <button type="button" onClick={() => onAssign(match.asset.id)}
            title={match.hasConflict ? 'This asset has an overlapping load — assign anyway?' : 'Assign this load to the asset'}
            style={{
              padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: match.hasConflict ? '#d97706' : match.asset.color,
              color: '#fff', fontSize: 12, fontWeight: 700,
            }}>
            Assign
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '0 12px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {match.inboundMiles !== null && (
            <Chip
              label="Deadhead in"
              value={`${match.inboundMiles}mi`}
              color={match.inboundMiles > 80 ? '#d97706' : '#16a34a'}
              tooltip={`Straight-line miles from ${match.prevEvent ? `the delivery point of "${match.prevEvent.title.split(':')[0]}"` : 'the asset\'s last known position'} to this load's pickup. Lower = less empty driving.`}
            />
          )}
          {match.outboundMiles !== null && (
            <Chip
              label="Deadhead out"
              value={`${match.outboundMiles}mi`}
              color={match.outboundMiles > 80 ? '#d97706' : '#16a34a'}
              tooltip={`Straight-line miles from this load's delivery point to the pickup of the next scheduled load ("${match.nextEvent?.title.split(':')[0]}"). Lower = less empty driving after this load.`}
            />
          )}
          {match.gapMinutesBefore !== null && (
            <Chip
              label="Gap before"
              value={fmtGap(match.gapMinutesBefore)!}
              color={match.gapMinutesBefore < 30 ? '#dc2626' : 'var(--gc-text-2)'}
              tooltip={`Time between "${match.prevEvent?.title.split(':')[0]}" ending and this load starting. Under 30 min is very tight.`}
            />
          )}
          {match.gapMinutesAfter !== null && (
            <Chip
              label="Gap after"
              value={fmtGap(match.gapMinutesAfter)!}
              color={match.gapMinutesAfter < 30 ? '#dc2626' : 'var(--gc-text-2)'}
              tooltip={`Time between this load ending and "${match.nextEvent?.title.split(':')[0]}" starting. Under 30 min is very tight.`}
            />
          )}
          {match.prevEvent && (
            <Chip
              label="Prev load"
              value={match.prevEvent.title.split(':')[0]}
              color="var(--gc-text-3)"
              tooltip={`The load scheduled immediately before this one for ${match.asset.name}. The deadhead-in distance starts from this load's delivery point.`}
            />
          )}
          {match.nextEvent && (
            <Chip
              label="Next load"
              value={match.nextEvent.title.split(':')[0]}
              color="var(--gc-text-3)"
              tooltip={`The load scheduled immediately after this one for ${match.asset.name}. The deadhead-out distance ends at this load's pickup point.`}
            />
          )}
          <div style={{ width: '100%', marginTop: 2 }}>
            {match.reasons.map((r, i) => (
              <span key={i} style={{ fontSize: 11, color: 'var(--gc-text-3)', marginRight: 8 }}>· {r}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ label, value, color, tooltip }: { label: string; value: string; color: string; tooltip: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const handleMouseEnter = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    }
  };

  return (
    <>
      <div
        ref={ref}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setPos(null)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 8px', borderRadius: 20,
          background: 'var(--gc-hover)', fontSize: 11,
          cursor: 'help',
        }}
      >
        <span style={{ color: 'var(--gc-text-3)' }}>{label}:</span>
        <span style={{ fontWeight: 600, color }}>{value}</span>
      </div>
      {pos && createPortal(
        <div style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y - 8,
          transform: 'translate(-50%, -100%)',
          background: '#1e293b', color: '#f1f5f9',
          fontSize: 11, lineHeight: 1.45, fontWeight: 400,
          padding: '6px 10px', borderRadius: 6,
          width: 220, whiteSpace: 'normal',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          zIndex: 9999, pointerEvents: 'none',
        }}>
          {tooltip}
        </div>,
        document.body,
      )}
    </>
  );
}

export default function SmartAssignDrawer() {
  const { smartAssignEventId, setSmartAssignEventId, events, assets, unassignedAssetId, updateEvent, openEditModal } = useCalendarStore();

  const load = useMemo(() => events.find(e => e.id === smartAssignEventId) ?? null, [events, smartAssignEventId]);

  const matches = useMemo(() => {
    if (!load) return [];
    return scoreAssetsForLoad(load, assets, events, unassignedAssetId);
  }, [load, assets, events, unassignedAssetId]);

  if (!smartAssignEventId || !load) return null;

  const route = (() => {
    const stops = load.stops ?? [];
    const pickup   = stops.find(s => s.type === 'pickup')   ?? stops[0];
    const delivery = [...stops].reverse().find(s => s.type === 'delivery') ?? stops[stops.length - 1];
    const from = pickup?.address?.split(',').slice(0, 2).join(',') ?? null;
    const to   = delivery?.address?.split(',').slice(0, 2).join(',') ?? null;
    if (from && to && from !== to) return `${from} → ${to}`;
    return from ?? to ?? null;
  })();

  const handleAssign = (assetId: number) => {
    updateEvent(load.id, { assetId });
    setSmartAssignEventId(null);
  };


  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.25)' }}
        onClick={() => setSmartAssignEventId(null)}
      />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 50,
        width: 380, background: 'var(--gc-bg)',
        borderLeft: '1px solid var(--gc-border)',
        display: 'flex', flexDirection: 'column',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
        animation: 'slideInRight 160ms ease-out',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--gc-border-light)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Zap size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Smart Assign</span>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)', lineHeight: 1.3 }}>{load.title}</div>
            {route && <div style={{ fontSize: 12, color: 'var(--gc-text-3)', marginTop: 2 }}>{route}</div>}
            <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--gc-text-2)' }}>{fmtTime(load.start)} – {fmtTime(load.end)}</span>
              {load.broker && <span style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>{load.broker}</span>}
              {load.loadNum && <span style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>#{load.loadNum}</span>}
              {load.loadPrice != null && <span style={{ fontSize: 12, fontWeight: 600, color: '#16a34a' }}>${load.loadPrice.toLocaleString()}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button type="button" onClick={() => { setSmartAssignEventId(null); openEditModal(load.id); }}
              style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
              Edit
            </button>
            <button type="button" onClick={() => setSmartAssignEventId(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-3)', padding: 2, display: 'flex', alignItems: 'center' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Match list — ranked by score, best first */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {matches.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--gc-text-3)', fontSize: 13, marginTop: 40 }}>No assets found</div>
          )}
          {matches.map(m => (
            <MatchRow key={m.asset.id} match={m} load={load} onAssign={handleAssign} />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(40px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  );
}
