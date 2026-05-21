/**
 * AssetSelect — custom dropdown that renders each asset row with its
 * color swatch + truck icon + name + unit number. Drop-in replacement
 * for the native <select> we used to use for the asset picker on the
 * EventModal (load create / edit form, and the relay-leg delivery
 * asset picker). Native <select> can't render icons inside its
 * options — OS limitation — so a custom widget is the only way to
 * get the colored swatch in the choices list.
 *
 * Behavior:
 *   - Click trigger → opens a panel below with all options.
 *   - Click option → selects + closes.
 *   - Click outside → closes without changing.
 *   - Esc → closes without changing.
 *   - Empty list (no `options`) → trigger renders as disabled.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { Truck } from 'lucide-react';

export interface AssetSelectOption {
  id:     number;
  name:   string;
  unit?:  string;
  /** Asset's hex color — drives the swatch behind the truck icon.
   *  Defaults to a neutral gray if missing. */
  color?: string;
}

export interface AssetSelectProps {
  value:    number;
  options:  AssetSelectOption[];
  onChange: (id: number) => void;
  /** Forwarded to the trigger button for theme alignment with the rest
   *  of the form fields (border, padding, etc). */
  style?:   React.CSSProperties;
  /** Color the trigger's border takes when focused. Matches the other
   *  fields' focusColor handler so the visual flow is consistent. */
  focusColor?: string;
  /** Optional placeholder for when value matches no option (shouldn't
   *  happen in practice but defensive). */
  placeholder?: string;
}

export function AssetSelect({
  value, options, onChange, style, focusColor = '#1a73e8', placeholder = 'Select asset',
}: AssetSelectProps) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = options.find(o => o.id === value) ?? null;

  // Close on outside click + Escape — same pattern as the other custom
  // dropdowns in this file (DriverPhoneCopy, etc).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={options.length === 0}
        style={{
          ...style,
          width: '100%',
          paddingRight: 36,
          textAlign: 'left',
          cursor: options.length === 0 ? 'not-allowed' : 'pointer',
          borderColor: focused ? focusColor : (style?.borderColor ?? 'var(--gc-border)'),
          background: style?.background ?? 'var(--gc-surface)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <AssetRowContent asset={current} placeholder={placeholder} />
        {/* Chevron — matches StyledSelect */}
        <div style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--gc-text-3)' }}>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M1.5 3.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </button>

      {open && (
        <div
          style={{
            position:    'absolute',
            zIndex:      100,
            top:         'calc(100% + 4px)',
            left:        0,
            right:       0,
            maxHeight:   280,
            overflowY:   'auto',
            background:  'var(--gc-surface)',
            border:      '1px solid var(--gc-border)',
            borderRadius: 10,
            boxShadow:   '0 10px 28px rgba(0,0,0,0.14)',
            padding:     4,
          }}
        >
          {options.map(opt => {
            const isSelected = opt.id === value;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => { onChange(opt.id); setOpen(false); }}
                style={{
                  width:       '100%',
                  display:     'flex',
                  alignItems:  'center',
                  gap:         10,
                  padding:     '8px 10px',
                  borderRadius: 6,
                  background:  isSelected ? 'var(--gc-blue-light)' : 'transparent',
                  border:      'none',
                  textAlign:   'left',
                  cursor:      'pointer',
                  color:       'var(--gc-text-1)',
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <AssetRowContent asset={opt} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Internal — renders the swatch + truck + name + unit triple. Used
 *  by both the trigger and each option row so they stay in sync. */
function AssetRowContent({ asset, placeholder }: { asset: AssetSelectOption | null; placeholder?: string }) {
  if (!asset) {
    return (
      <span style={{ flex: 1, fontSize: 14, color: 'var(--gc-text-3)' }}>
        {placeholder ?? 'Select asset'}
      </span>
    );
  }
  return (
    <>
      <div
        style={{
          width: 22, height: 22, borderRadius: 6,
          background: asset.color ?? '#9aa0a6',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Truck size={12} color="#ffffff" strokeWidth={2.4} />
      </div>
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: 'var(--gc-text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {asset.name}
        {asset.unit && (
          <span style={{ color: 'var(--gc-text-3)', marginLeft: 6 }}>
            #{asset.unit}
          </span>
        )}
      </span>
    </>
  );
}
