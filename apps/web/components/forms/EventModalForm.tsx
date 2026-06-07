/**
 * Shared form primitives between the calendar EventModal and any
 * surface that wants to render fields with the same visual treatment
 * (the load detail page, work-order modals, etc.).
 *
 * Source of truth was components/calendar/EventModal.tsx; lifted here
 * so consumers can match the modal pixel-for-pixel without copy-paste
 * drift.
 */

'use client';

import type { CSSProperties, FocusEvent, ReactNode } from 'react';

/**
 * Standard text/select input styling. Field sizing follows the
 * surrounding `.ui-scale-scope --ui-scale` (set by the modal root from
 * Settings → Appearance → Calendar card text). Outside a scoped surface
 * the var falls back to 1 so other callers keep their original feel.
 */
export function inputStyle(): CSSProperties {
  return {
    border: '1px solid var(--gc-border)',
    borderRadius: 8,
    padding: 'calc(8.5px * var(--ui-scale, 1)) calc(11px * var(--ui-scale, 1))',
    fontSize: 'calc(13.5px * var(--ui-scale, 1))',
    color: 'var(--gc-text-1)',
    outline: 'none',
    background: 'var(--gc-surface)',
    width: '100%',
    transition: 'border-color 150ms',
    cursor: 'auto',
  };
}

/** Focus handler: shift the border to the surface's accent color. */
export function focusColor(color: string) {
  return function onFocus(
    e: FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) {
    e.currentTarget.style.borderColor = color;
  };
}

/** Matching blur handler — neutralises the border. */
export function blurColor(
  e: FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
) {
  e.currentTarget.style.borderColor = 'var(--gc-border)';
}

/**
 * Label + content wrapper used inside every modal section. Label is
 * 11px semibold uppercase tracking-wider, content stacks below. Pass
 * `labelSuffix` for a small inline chip (e.g. an "auto" badge) that
 * sits flush with the label.
 */
export function Field({
  label, labelSuffix, children,
}: {
  label: string;
  labelSuffix?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--gc-text-3)' }}>
          {label}
        </label>
        {labelSuffix}
      </div>
      {children}
    </div>
  );
}

/**
 * Section wrapper. Pass `first` for the topmost section so the
 * upper divider doesn't render. Header reads as
 * `text-[11px] font-bold uppercase tracking-wider mb-4` in --gc-text-3.
 */
export function ModalSection({
  title, first, children,
}: {
  title: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={first ? {} : { borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
      <div className="text-[11px] font-bold uppercase tracking-wider mb-4"
        style={{ color: 'var(--gc-text-3)' }}>
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}
