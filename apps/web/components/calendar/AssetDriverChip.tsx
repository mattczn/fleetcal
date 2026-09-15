'use client';

/**
 * AssetDriverChip — who is in this truck today, and how much time they
 * have left, shown under the truck name in the calendar column header.
 *
 * The header is a "right now" view: it already shows live ELD position
 * the same way. So this shows the driver on the truck's active load,
 * and it changes through the day as loads hand over. A stale name here
 * is worse than one that moves.
 *
 * Clicking opens a picker to correct it, because the automatic answer
 * is wrong often enough to matter — a truck with no load assigned yet,
 * a swap nobody entered, a relay with overlapping legs. That matters
 * more than cosmetics now that the chip carries HOURS: the wrong name
 * shows a dispatcher the wrong person's remaining time and invites a
 * decision based on it.
 *
 * Column widths are tight (the header already collapses under 130px and
 * drops the unit label under 90px), so the chip degrades: full name plus
 * hours, then name alone, then initials with the detail on hover.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { User, Check, ExternalLink } from 'lucide-react';
import { railway, type HosAssetDriver, type HosDriverOption } from '@/lib/railway';
import { useHosPanel } from '@/lib/useHosPanel';

function fmtHours(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h`;
}

const SHIFT_WINDOW_SECONDS = 14 * 3600;

/** Popover has room for minutes; the chip itself does not. */
function fmtLong(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** First name plus last initial — "Luis G". Full names don't fit a
 *  calendar column and a bare first name collides across a fleet with
 *  two Luises and three Miguels. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}`;
}

type Tone = 'on' | 'tight' | 'out' | 'off' | 'unknown';

function toneOf(a: HosAssetDriver): Tone {
  const h = a.hos;
  if (!h) return 'unknown';
  if (h.stale) return 'out';
  if (h.status === 'on_duty') {
    const left = h.windowRemainingSeconds ?? 0;
    if (left <= 0) return 'out';
    return left <= 3 * 3600 ? 'tight' : 'on';
  }
  // Off duty but the 14-hour window is still open — they can be sent
  // back out right now, which is materially different from resting.
  if (h.canResumeWithinWindow) return 'tight';
  return 'off';
}

const TONE_COLOR: Record<Tone, string> = {
  on:      '#16a34a',
  tight:   '#d97706',
  out:     '#dc2626',
  off:     'var(--gc-text-4, #a4abb4)',
  unknown: 'var(--gc-border-strong, #d6dbe2)',
};

function hoverText(a: HosAssetDriver): string {
  if (!a.driverName) return 'No driver resolved for this truck — click to set one';
  const h = a.hos;
  const who = `${a.driverName}${a.source === 'override' ? ' (set by dispatch)' : ''}`;
  if (!h) return `${who} — HOS not tracked`;
  if (h.stale) return `${who} — shift left open past 14 hours, needs correcting`;
  if (h.status === 'on_duty') {
    return `${who} — on duty, ${fmtHours(h.windowRemainingSeconds)} left in the 14 hour window`;
  }
  if (h.canResumeWithinWindow) {
    return `${who} — off duty, but can still work until the window closes`;
  }
  if (h.availableAt) {
    const t = new Date(h.availableAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${who} — off duty, available ${t}`;
  }
  return `${who} — rested, full 14 hours available`;
}

export default function AssetDriverChip({ entry, width, onChanged }: {
  entry: HosAssetDriver | null;
  /** Column width, so the chip can shed detail as it narrows. */
  width: number;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<HosDriverOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const openHosPanel = useHosPanel(s => s.openFor);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  const assetId = entry?.assetId ?? null;

  const openPicker = useCallback(async () => {
    if (assetId == null) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    if (options === null) {
      try {
        const res = await railway.getAssetDriverOptions(assetId);
        setOptions(res.drivers);
      } catch {
        setOptions([]);
      }
    }
  }, [assetId, options]);

  const pick = async (driverId: number | null) => {
    if (assetId == null) return;
    setBusy(true);
    try {
      await railway.setAssetDriver(assetId, driverId);
      setOpen(false);
      onChanged();
    } catch {
      /* leave the picker open so the dispatcher can retry */
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-driver-picker]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!entry) return null;

  const tone = toneOf(entry);
  const dot = TONE_COLOR[tone];
  const name = entry.driverName;
  const hours = entry.hos?.status === 'on_duty'
    ? fmtHours(entry.hos.windowRemainingSeconds)
    : '';

  // Shed detail as the column narrows.
  const showHours = width >= 150 && hours !== '';
  const label = !name
    ? '—'
    : width >= 110 ? shortName(name) : initials(name);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-driver-picker
        onClick={(e) => { e.stopPropagation(); void openPicker(); }}
        title={hoverText(entry)}
        className="flex items-center justify-center w-full rounded transition-colors"
        style={{
          gap: 4, marginTop: 3, padding: '2px 4px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          maxWidth: '100%',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span aria-hidden style={{
          width: 6, height: 6, borderRadius: 3, background: dot, flexShrink: 0,
        }} />
        <span
          className="text-[10px] font-medium truncate leading-none"
          style={{ color: name ? 'var(--gc-text-2)' : 'var(--gc-text-4, #a4abb4)' }}
        >
          {label}
        </span>
        {showHours && (
          <span className="text-[10px] leading-none tabular-nums" style={{ color: 'var(--gc-text-3)', flexShrink: 0 }}>
            {hours}
          </span>
        )}
      </button>

      {open && anchor && createPortal(
        <div
          data-driver-picker
          style={{
            position: 'fixed', top: anchor.top, left: anchor.left, zIndex: 80,
            minWidth: 210, maxHeight: 320, overflowY: 'auto',
            background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)',
            borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.18)', padding: 4,
          }}
        >
          <div style={{
            padding: '6px 8px 4px', fontSize: 10, fontWeight: 700,
            letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--gc-text-3)',
          }}>
            Driver in {entry.assetName}
          </div>

          {/* Hours first — the reason a dispatcher clicked this chip is
              usually "can I give them this run", not "who is it". */}
          {entry.driverId != null && (
            <div style={{
              margin: '2px 4px 6px', padding: '8px 9px', borderRadius: 7,
              background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)',
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--gc-text-1)' }}>
                {entry.driverName}
              </div>
              {entry.hos ? (() => {
                const h = entry.hos;
                // Elapsed against the 14-hour window, not the shift —
                // after a short break those differ and the window is the
                // one with legal teeth.
                const left = h.windowRemainingSeconds;
                const used = left != null ? SHIFT_WINDOW_SECONDS - left : null;
                const pct = used != null ? Math.min(1, Math.max(0, used / SHIFT_WINDOW_SECONDS)) : 0;
                const tone = toneOf(entry);
                return (
                  <>
                    <div style={{
                      fontSize: 12, marginTop: 3, color: 'var(--gc-text-2)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {h.status === 'on_duty' && used != null ? (
                        <>
                          <strong style={{ color: TONE_COLOR[tone] }}>{fmtLong(used)}</strong>
                          {' of 14h used · '}{fmtLong(left)} left
                        </>
                      ) : h.status === 'on_duty' ? 'On duty'
                        : h.canResumeWithinWindow && left != null
                          ? <>Off duty · <strong style={{ color: TONE_COLOR[tone] }}>{fmtLong(left)}</strong> still available today</>
                          : h.availableAt
                            ? <>Off duty · back {new Date(h.availableAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</>
                            : 'Off duty · rested'}
                    </div>
                    {h.status === 'on_duty' && (
                      <div style={{
                        height: 4, borderRadius: 2, marginTop: 6,
                        background: 'var(--gc-border-light)', overflow: 'hidden',
                      }}>
                        <div style={{ width: `${pct * 100}%`, height: '100%', background: TONE_COLOR[tone] }} />
                      </div>
                    )}
                  </>
                );
              })() : (
                <div style={{ fontSize: 11.5, marginTop: 3, color: 'var(--gc-text-3)' }}>
                  Hours not tracked for this driver
                </div>
              )}

              <button
                type="button"
                onClick={() => { setOpen(false); openHosPanel(entry.driverId); }}
                style={{
                  width: '100%', marginTop: 8, padding: '6px 9px', borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                  border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)',
                  color: 'var(--gc-text-1)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                }}
              >
                <ExternalLink size={11} /> Open timesheet
              </button>
            </div>
          )}

          <div style={{
            padding: '4px 8px 2px', fontSize: 9.5, fontWeight: 700,
            letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--gc-text-4, #a4abb4)',
          }}>
            Change driver
          </div>

          {options === null ? (
            <div style={{ padding: 10, fontSize: 12, color: 'var(--gc-text-3)' }}>Loading…</div>
          ) : (
            <>
              {entry.source === 'override' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pick(null)}
                  style={{
                    width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 6,
                    border: 'none', background: 'transparent', cursor: 'pointer',
                    fontSize: 12, color: 'var(--gc-text-3)',
                  }}
                >
                  Clear — use the assigned load instead
                </button>
              )}
              {options.map((o, i) => {
                const prev = options[i - 1];
                // Only label the first of each group; repeating "recent"
                // down a list of twelve drivers is noise.
                const showGroup = !prev || prev.relation !== o.relation;
                const groupLabel = o.relation === 'primary' ? 'Assigned to this truck'
                  : o.relation === 'secondary' ? 'Shares this truck'
                  : o.relation === 'recent' ? 'Has driven it recently'
                  : 'Other drivers';
                const selected = o.driverId === entry.driverId;
                return (
                  <div key={o.driverId}>
                    {showGroup && (
                      <div style={{
                        padding: '6px 8px 2px', fontSize: 9.5, fontWeight: 700,
                        letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--gc-text-4, #a4abb4)',
                      }}>
                        {groupLabel}
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void pick(o.driverId)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                        textAlign: 'left', padding: '6px 8px', borderRadius: 6,
                        border: 'none', cursor: 'pointer',
                        background: selected ? 'var(--gc-bg)' : 'transparent',
                        fontSize: 12.5, color: 'var(--gc-text-1)',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = selected ? 'var(--gc-bg)' : 'transparent'; }}
                    >
                      <User size={12} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                      <span className="truncate" style={{ flex: 1 }}>{o.name}</span>
                      {selected && <Check size={12} style={{ color: '#16a34a', flexShrink: 0 }} />}
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
