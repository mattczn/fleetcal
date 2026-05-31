'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  value: string;        // YYYY-MM-DD
  onChange: (v: string) => void;
  headerColor: string;
  min?: string;
  required?: boolean;
  /** Override the button label. When omitted, falls back to
   *  `formatDisplay(value)` ("Sat, May 19, 2026"). Useful for the
   *  calendar toolbar which wants to show a custom format
   *  ("May 19 – 25, 2026" for the week range). */
  displayText?: string;
  /** Optional className passed to the trigger button. Lets callers
   *  swap the visual style (e.g. the toolbar wants a borderless
   *  header label, not a bordered input). */
  buttonClassName?: string;
  /** Optional inline style overrides for the trigger button. Merged
   *  on top of the defaults so callers can drop the border, change
   *  font size, etc. without rebuilding the trigger from scratch. */
  buttonStyle?: React.CSSProperties;
  /** Optional inline style for the outer wrapper. Useful when the
   *  default `flex: 1` (which makes the picker eat all available row
   *  width) is wrong — e.g. a toolbar with multiple controls where
   *  the picker should size to content. */
  containerStyle?: React.CSSProperties;
}

const DOW   = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];

function formatDisplay(v: string): string {
  if (!v) return '';
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function todayStr(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
}

export default function DatePicker({ value, onChange, headerColor, min, required, displayText, buttonClassName, buttonStyle, containerStyle }: Props) {
  const [open, setOpen]         = useState(false);
  const [popupPos, setPopupPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [viewYear, setVY]       = useState(() => value ? parseInt(value.slice(0, 4)) : new Date().getFullYear());
  const [viewMonth, setVM]      = useState(() => value ? parseInt(value.slice(5, 7)) - 1 : new Date().getMonth());
  const ref                     = useRef<HTMLDivElement>(null);
  const popupRef                = useRef<HTMLDivElement>(null);
  const btnRef                  = useRef<HTMLButtonElement>(null);

  // Sync view when value changes externally
  useEffect(() => {
    if (value) {
      setVY(parseInt(value.slice(0, 4)));
      setVM(parseInt(value.slice(5, 7)) - 1);
    }
  }, [value]);

  // Close on outside click (check both the trigger wrapper and the fixed popup)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        ref.current && !ref.current.contains(t) &&
        popupRef.current && !popupRef.current.contains(t)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = useCallback(() => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Flip upward if not enough space below
      const spaceBelow = window.innerHeight - r.bottom;
      const popupH = 320; // approx height
      const top = spaceBelow < popupH ? r.top - popupH - 6 : r.bottom + 6;
      setPopupPos({ top, left: r.left });
    }
    setOpen(o => !o);
  }, [open]);

  const goMonth = (delta: number) => {
    let m = viewMonth + delta, y = viewYear;
    if (m < 0)  { m = 11; y--; }
    if (m > 11) { m = 0;  y++; }
    setVM(m); setVY(y);
  };

  const firstDOW    = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(firstDOW).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const today = todayStr();

  const pick = (day: number) => {
    const v = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    if (min && v < min) return;
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 0, ...containerStyle }}>
      {/* Trigger button */}
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        className={buttonClassName}
        style={{
          width: '100%',
          border: `1px solid ${open ? headerColor : 'var(--gc-border)'}`,
          borderRadius: 8,
          padding: '10px 13px',
          fontSize: 15,
          color: value ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
          background: 'var(--gc-surface)',
          textAlign: 'left',
          cursor: 'pointer',
          transition: 'border-color 150ms',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          ...buttonStyle,
        }}
      >
        {displayText ?? (value ? formatDisplay(value) : 'Select date…')}
      </button>

      {/* Calendar popover — fixed so it escapes modal overflow clipping */}
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
            padding: '14px 12px 12px',
            width: 280,
          }}
        >
          {/* Month nav */}
          <div className="flex items-center justify-between mb-3">
            <button type="button" onClick={() => goMonth(-1)}
              className="p-1.5 rounded-full transition-colors"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <ChevronLeft size={16} />
            </button>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)' }}>
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button type="button" onClick={() => goMonth(1)}
              className="p-1.5 rounded-full transition-colors"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <ChevronRight size={16} />
            </button>
          </div>

          {/* DOW headers */}
          <div className="grid grid-cols-7 mb-1">
            {DOW.map(d => (
              <div key={d} className="flex items-center justify-center"
                style={{ height: 28, fontSize: 11, fontWeight: 700, color: 'var(--gc-text-3)' }}>
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((day, i) => {
              if (!day) return <div key={i} style={{ height: 36 }} />;
              const dStr    = `${viewYear}-${String(viewMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
              const isSel   = dStr === value;
              const isTday  = dStr === today;
              const disabled = !!(min && dStr < min);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => !disabled && pick(day)}
                  className="flex items-center justify-center rounded-full transition-colors mx-auto"
                  style={{
                    width: 36, height: 36,
                    fontSize: 13,
                    fontWeight: isSel || isTday ? 700 : 400,
                    background: isSel ? headerColor : 'transparent',
                    color: isSel ? 'white' : isTday ? headerColor : disabled ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
                    cursor: disabled ? 'default' : 'pointer',
                    outline: isTday && !isSel ? `2px solid ${headerColor}` : 'none',
                    outlineOffset: -2,
                  }}
                  onMouseEnter={e => { if (!isSel && !disabled) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = isSel ? headerColor : 'transparent'; }}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Today shortcut */}
          <div className="flex justify-center mt-2 pt-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <button
              type="button"
              onClick={() => { onChange(today); setOpen(false); }}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{ color: headerColor }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
