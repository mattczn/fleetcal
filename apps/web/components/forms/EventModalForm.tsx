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

import { useState } from 'react';
import type { CSSProperties, FocusEvent, ReactNode } from 'react';
import { Phone, Plus } from 'lucide-react';

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

/**
 * Driver phone chip — copy-to-clipboard button. Same look as
 * EventModal's driver phone chip: phone icon + number, hover tint,
 * 1.5s "Copied!" green flip on click.
 */
export function DriverPhoneCopy({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(phone).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" onClick={onClick}
      title={copied ? 'Copied!' : 'Click to copy'}
      className="mt-1.5 text-xs flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors"
      style={{ color: copied ? '#15803d' : 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <Phone size={11} />
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{phone}</span>
      {copied && (
        <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 4 }}>✓</span>
      )}
    </button>
  );
}

/**
 * "+ Internal Note" button — dashed amber outline, expands into a
 * yellow notes card when clicked. Same look as EventModal.
 * Currently render-only here; the page can pass an onClick to wire
 * the composer up when ready.
 */
export function InternalNoteButton({ onClick, label }: {
  onClick?: () => void;
  label?: string;
}) {
  return (
    <button type="button" onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 12, fontWeight: 600, padding: '4px 10px',
        borderRadius: 6, border: '1px dashed #d4a017',
        background: 'transparent', color: '#a16207', cursor: onClick ? 'pointer' : 'default',
      }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.background = '#fef9c3'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      <Plus size={12} /> {label ?? 'Internal Note'}
    </button>
  );
}
