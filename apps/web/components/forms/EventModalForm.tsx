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

import { useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, ReactNode } from 'react';
import { Copy, Phone, Plus, X } from 'lucide-react';
import type { RefNum } from '@fleetcal/types';

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

/** Default preset chips offered below the RefNums add row. Lifted out
 *  of EventModal so the load detail page and any other consumer renders
 *  the same six quick-pick buttons. */
export const PRESET_REF_LABELS = ['Pickup #', 'Delivery #', 'BOL', 'PO #', 'PRO #', 'Order #'];

/**
 * Reference-number editor used by EventModal and the load detail page.
 *
 * Renders existing refs as inline chip badges (× to confirm-remove, a
 * Copy icon to copy the value), an add row with label + value inputs +
 * "Add" button, and a row of preset chips that prefill the label field
 * and focus the value input.
 *
 * `chipBg` / `chipBorder` parameterize the badge color so revenue loads
 * keep the blue accent and other consumers can theme it. Pass
 * `headerColor` to set the focus-ring + Add-button + active-chip color.
 *
 * The component owns its own add-draft state, remove-confirm state, and
 * 5-second undo timer — the parent only owns the persisted ref list via
 * (value, onChange).
 */
export function RefNumsField({
  value, onChange, headerColor, chipBg, chipBorder,
}: {
  value: RefNum[];
  onChange: (v: RefNum[]) => void;
  headerColor: string;
  chipBg: string;
  chipBorder: string;
}) {
  const [draftLabel, setDraftLabel] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [copiedIdx, setCopiedIdx]   = useState<number | null>(null);
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  const [lastRemoved, setLastRemoved] = useState<{ ref: RefNum; idx: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const v = draftValue.trim();
    if (!v) return;
    onChange([...value, { label: draftLabel.trim(), value: v }]);
    setDraftLabel(''); setDraftValue('');
  };

  const remove = (i: number) => {
    setLastRemoved({ ref: value[i], idx: i });
    onChange(value.filter((_, idx) => idx !== i));
    setConfirmIdx(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setLastRemoved(null), 5000);
  };

  const undo = () => {
    if (!lastRemoved) return;
    const next = [...value];
    next.splice(lastRemoved.idx, 0, lastRemoved.ref);
    onChange(next);
    setLastRemoved(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
  };

  const copy = (ref: RefNum, i: number) => {
    // Copy the value only — the label is just a UI hint and pasting it
    // into another system (broker portal, BOL, etc.) is rarely useful.
    void navigator.clipboard.writeText(ref.value).then(() => {
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  };

  const inp: CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 6,
    padding: '5px 8px', fontSize: 13, outline: 'none',
    color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Existing ref badges */}
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {value.map((ref, i) => (
            confirmIdx === i ? (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8, background: '#fee2e2', border: '1px solid #fca5a5', fontSize: 12 }}>
                <span style={{ color: '#991b1b', fontWeight: 600, whiteSpace: 'nowrap' }}>Remove?</span>
                <button type="button" onClick={() => remove(i)}
                  style={{ background: '#d93025', border: 'none', borderRadius: 4, cursor: 'pointer', padding: '1px 7px', fontSize: 11, fontWeight: 700, color: '#fff' }}>
                  Yes
                </button>
                <button type="button" onClick={() => setConfirmIdx(null)}
                  style={{ background: 'none', border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer', padding: '1px 7px', fontSize: 11, fontWeight: 600, color: '#991b1b' }}>
                  No
                </button>
              </div>
            ) : (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 6px', borderRadius: 8, background: chipBg, border: `1px solid ${chipBorder}`, fontSize: 12 }}>
                <button type="button" onClick={() => setConfirmIdx(i)} title="Remove"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', color: 'var(--gc-text-3)', transition: 'color 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#d93025')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-3)')}>
                  <X size={10} />
                </button>
                <span style={{ fontWeight: 600, color: 'var(--gc-text-1)', whiteSpace: 'nowrap' }}>
                  {ref.label ? <><span style={{ color: 'var(--gc-text-3)' }}>{ref.label}</span>{' '}{ref.value}</> : ref.value}
                </span>
                <button type="button" onClick={() => copy(ref, i)} title="Copy"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', color: copiedIdx === i ? '#15803d' : 'var(--gc-text-3)', transition: 'color 120ms' }}>
                  <Copy size={10} />
                </button>
              </div>
            )
          ))}
        </div>
      )}
      {/* Undo row */}
      {lastRemoved && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
            Removed {lastRemoved.ref.label ? `${lastRemoved.ref.label} ${lastRemoved.ref.value}` : lastRemoved.ref.value}
          </span>
          <button type="button" onClick={undo}
            style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
            ↩ Undo
          </button>
        </div>
      )}

      {/* Add row: [label] [number] [Add] */}
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input
          type="text" value={draftLabel} onChange={e => setDraftLabel(e.target.value)}
          placeholder="Type (e.g. BOL)"
          style={{ ...inp, width: 120, flexShrink: 0 }}
          onFocus={e => (e.currentTarget.style.borderColor = headerColor)}
          onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); valueRef.current?.focus(); } }}
        />
        <input
          ref={valueRef} type="text" value={draftValue} onChange={e => setDraftValue(e.target.value)}
          placeholder="Number"
          style={{ ...inp, flex: 1 }}
          onFocus={e => (e.currentTarget.style.borderColor = headerColor)}
          onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        />
        <button type="button" onClick={commit} disabled={!draftValue.trim()}
          style={{ flexShrink: 0, padding: '5px 10px', borderRadius: 6, border: 'none', background: draftValue.trim() ? headerColor : 'var(--gc-hover)', color: draftValue.trim() ? '#fff' : 'var(--gc-text-3)', fontSize: 12, fontWeight: 600, cursor: draftValue.trim() ? 'pointer' : 'default', transition: 'background 150ms' }}>
          Add
        </button>
      </div>

      {/* Preset chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {PRESET_REF_LABELS.map(label => (
          <button key={label} type="button"
            onClick={() => { setDraftLabel(label); valueRef.current?.focus(); }}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-3)', cursor: 'pointer', transition: 'border-color 150ms, color 150ms' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = headerColor; e.currentTarget.style.color = headerColor; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gc-border)'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}
          >{label}</button>
        ))}
      </div>
    </div>
  );
}
