/**
 * StyledSelect — the wrapped `<select>` that matches FleetCal's
 * modal/form aesthetic.
 *
 * Native `<select>` doesn't let us restyle the dropdown arrow without
 * `appearance: none`, and once you turn that off the browser's
 * built-in chevron disappears. So we render our own SVG chevron as
 * an absolutely-positioned sibling and reserve right padding on the
 * underlying select for it to sit on top of.
 *
 * Originally lived inside calendar/EventModal.tsx; lifted here so
 * the maintenance work-order modal and future modals share one
 * implementation instead of duplicating.
 */

'use client';

import type { ReactNode, ChangeEventHandler, CSSProperties, FocusEventHandler } from 'react';

export function StyledSelect({
  value, onChange, onFocus, onBlur, style, children, disabled,
}: {
  value: string | number;
  onChange: ChangeEventHandler<HTMLSelectElement>;
  onFocus?: FocusEventHandler<HTMLSelectElement>;
  onBlur?: FocusEventHandler<HTMLSelectElement>;
  style?: CSSProperties;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <select
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        disabled={disabled}
        style={{
          ...style,
          appearance: 'none',
          WebkitAppearance: 'none',
          paddingRight: 36,
        } as CSSProperties}>
        {children}
      </select>
      <div
        style={{
          position: 'absolute',
          right: 11,
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          color: 'var(--gc-text-3)',
          display: 'flex',
        }}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M1.5 3.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
