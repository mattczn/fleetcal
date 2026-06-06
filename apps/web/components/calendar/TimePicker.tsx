'use client';

/**
 * TimePicker — text input + clock-icon trigger that opens a portal-
 * positioned hour / minute popover. Mirrors DatePicker's visual
 * language so combo inputs (date + time) feel like one control.
 *
 * Keeps the smart-text-input pattern from the legacy time field:
 * "8am" → "08:00", "9:30p" → "21:30". Picking from the popover
 * skips parsing entirely and writes the exact slot.
 *
 * Wire format: 24-hour "HH:MM" matching parseTimeInput's output and
 * the rest of the calendar's time strings.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { parseTimeInput } from '@/lib/time-utils';

interface Props {
  /** "HH:MM" 24-hour, or "" when empty. */
  value: string;
  onChange: (v: string) => void;
  /** Border color when focused / popover open + active slot highlight. */
  headerColor: string;
  /** Minute step inside the popover. Defaults to 15 — 5 catches finer
   *  appointment windows when needed. */
  minuteStep?: 5 | 10 | 15 | 30;
  /** Width override for the input. Defaults to 88px which fits "08:00"
   *  comfortably and lines up next to a DatePicker trigger. */
  inputWidth?: number | string;
  /** Optional inline style override for the input. Caller can change
   *  font size etc. to match a tighter / wider context. */
  inputStyle?: React.CSSProperties;
}

/** Format "HH:MM" → "8:00 AM" for the popover hour label. */
function fmt12(h: number, m: number): string {
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

export default function TimePicker({
  value,
  onChange,
  headerColor,
  minuteStep = 15,
  inputWidth = 88,
  inputStyle,
}: Props) {
  const [raw, setRaw]         = useState(value);
  const [open, setOpen]       = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref     = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Keep the text input in sync when value changes externally (e.g.
  // the parent's date changes and resets the time string).
  useEffect(() => { setRaw(value); }, [value]);

  // Commit typed input via parseTimeInput. Bad input snaps back to
  // the last good value rather than clearing.
  const commitTyped = () => {
    const parsed = parseTimeInput(raw);
    if (parsed) { setRaw(parsed); onChange(parsed); }
    else setRaw(value);
  };

  const handleOpen = useCallback(() => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const popupH = 280;
      const popupW = 200;
      const gutter = 8;
      const spaceBelow = window.innerHeight - r.bottom;
      const top  = spaceBelow < popupH ? r.top - popupH - 6 : r.bottom + 6;
      let left = r.left;
      if (left + popupW > window.innerWidth - gutter) {
        left = Math.max(gutter, r.right - popupW);
      }
      setPopupPos({ top, left });
    }
    setOpen(o => !o);
  }, [open]);

  // Outside click closes.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const inTrigger = ref.current?.contains(e.target as Node);
      const inPopup   = popupRef.current?.contains(e.target as Node);
      if (!inTrigger && !inPopup) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Parse current selection so the popover can highlight the active
  // hour + minute. If raw is empty or malformed, no highlight.
  const m = value.match(/^(\d{2}):(\d{2})$/);
  const selectedHour   = m ? parseInt(m[1], 10) : -1;
  const selectedMinute = m ? parseInt(m[2], 10) : -1;

  const minutes = Array.from({ length: 60 / minuteStep }, (_, i) => i * minuteStep);

  const pick = (h: number, mm: number) => {
    const v = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    setRaw(v);
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'stretch' }}>
      <input
        ref={inputRef}
        type="text"
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitTyped(); inputRef.current?.blur(); } }}
        onFocus={e => { requestAnimationFrame(() => e.target.select()); e.currentTarget.style.borderColor = headerColor; }}
        onBlur={e => { commitTyped(); e.currentTarget.style.borderColor = open ? headerColor : 'var(--gc-border)'; }}
        placeholder="8am"
        style={{
          width: inputWidth,
          border: `1px solid ${open ? headerColor : 'var(--gc-border)'}`,
          borderRight: 'none',
          borderTopLeftRadius: 8,
          borderBottomLeftRadius: 8,
          padding: 'calc(8.5px * var(--ui-scale, 1)) calc(8px * var(--ui-scale, 1))',
          fontSize: 'calc(13.5px * var(--ui-scale, 1))',
          color: 'var(--gc-text-1)', outline: 'none', cursor: 'text',
          transition: 'border-color 150ms',
          background: 'var(--gc-surface)',
          boxSizing: 'border-box',
          ...inputStyle,
        }}
      />
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        title="Pick time"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 8px',
          border: `1px solid ${open ? headerColor : 'var(--gc-border)'}`,
          borderTopRightRadius: 8, borderBottomRightRadius: 8,
          background: open ? 'var(--gc-blue-light)' : 'var(--gc-surface)',
          color: open ? headerColor : 'var(--gc-text-3)',
          cursor: 'pointer',
          transition: 'border-color 150ms, background 150ms, color 150ms',
        }}
        onMouseEnter={e => { if (!open) { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = headerColor; } }}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.background = 'var(--gc-surface)'; e.currentTarget.style.color = 'var(--gc-text-3)'; } }}>
        <Clock size={12} />
      </button>

      {open && (
        <div
          ref={popupRef}
          style={{
            position: 'fixed',
            top: popupPos.top,
            left: popupPos.left,
            zIndex: 9999,
            background: 'var(--gc-surface)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-3)',
            padding: 8,
            width: 200,
            display: 'flex',
            gap: 4,
          }}>
          {/* Hours */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="text-[10px] font-bold uppercase tracking-widest mb-1.5 text-center"
              style={{ color: 'var(--gc-text-3)' }}>
              Hour
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto', borderRadius: 6 }}>
              {Array.from({ length: 24 }, (_, h) => h).map(h => {
                const isSelected = h === selectedHour;
                return (
                  <button
                    key={h}
                    type="button"
                    onClick={() => pick(h, selectedMinute >= 0 ? selectedMinute : 0)}
                    className="w-full transition-colors"
                    style={{
                      padding: '6px 8px',
                      fontSize: 12,
                      fontWeight: isSelected ? 700 : 500,
                      color:      isSelected ? '#fff' : 'var(--gc-text-1)',
                      background: isSelected ? headerColor : 'transparent',
                      borderRadius: 6,
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      paddingLeft: 12,
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}>
                    {fmt12(h, 0).replace(/:00\s/, ' ')}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Minutes */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="text-[10px] font-bold uppercase tracking-widest mb-1.5 text-center"
              style={{ color: 'var(--gc-text-3)' }}>
              Min
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto', borderRadius: 6 }}>
              {minutes.map(mm => {
                const isSelected = mm === selectedMinute;
                return (
                  <button
                    key={mm}
                    type="button"
                    onClick={() => pick(selectedHour >= 0 ? selectedHour : 8, mm)}
                    className="w-full transition-colors"
                    style={{
                      padding: '6px 8px',
                      fontSize: 12,
                      fontWeight: isSelected ? 700 : 500,
                      color:      isSelected ? '#fff' : 'var(--gc-text-1)',
                      background: isSelected ? headerColor : 'transparent',
                      borderRadius: 6,
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}>
                    :{String(mm).padStart(2, '0')}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
