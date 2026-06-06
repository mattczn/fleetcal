'use client';

/**
 * DateTimeInput — shared "YYYY-MM-DDTHH:mm" picker.
 *
 * Visual parity with the load-modal Appt input (StopsSection's
 * ApptInput): a DatePicker for the date, a smart-parsing text input
 * for the time ("8am" → "08:00"), and a small × to clear. When
 * `value` is empty, renders a single placeholder button that primes
 * today @ 08:00 on first click — keeps optional fields visually
 * lightweight until the user opts in.
 *
 * Use this anywhere we'd otherwise reach for `<input type="datetime-
 * local">` — the native control is unstyled and inconsistent across
 * browsers, while this matches the load modal exactly.
 */

import { useEffect, useState } from 'react';
import DatePicker from '@/components/calendar/DatePicker';
import { parseTimeInput } from '@/lib/time-utils';

interface Props {
  /** "YYYY-MM-DDTHH:mm" or "" when empty. */
  value: string;
  onChange: (v: string) => void;
  /** Color used for focused-border + DatePicker header. */
  accentColor: string;
  /** Label shown on the empty-state button. */
  placeholder?: string;
  /** Size variant. 'md' matches the load modal's appt input;
   *  'sm' is tighter for inline form rows like check-call entry. */
  size?: 'sm' | 'md';
  /** Default time when the user opens an empty picker. Defaults
   *  to "08:00" to match the StopsSection pattern. */
  defaultTime?: string;
}

function TimeText({ value, onChange, accentColor, size }: {
  value: string; onChange: (v: string) => void; accentColor: string; size: 'sm' | 'md';
}) {
  const [raw, setRaw] = useState(value);
  useEffect(() => { setRaw(value); }, [value]);
  const commit = () => {
    const parsed = parseTimeInput(raw);
    if (parsed) { setRaw(parsed); onChange(parsed); }
    else setRaw(value);
  };
  const dims = size === 'sm'
    ? { width: 64, padding: '5px 7px', fontSize: 12 }
    : { width: 'calc(68px * var(--ui-scale, 1))', padding: 'calc(8.5px * var(--ui-scale, 1)) calc(8px * var(--ui-scale, 1))', fontSize: 'calc(13.5px * var(--ui-scale, 1))' as const };
  return (
    <input
      type="text" value={raw}
      onChange={e => setRaw(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      placeholder="8am"
      style={{
        ...dims,
        border: '1px solid var(--gc-border)', borderRadius: 8,
        color: 'var(--gc-text-1)', outline: 'none', cursor: 'text',
        transition: 'border-color 150ms', background: 'var(--gc-surface)',
      }}
      onFocus={e => { requestAnimationFrame(() => e.target.select()); e.currentTarget.style.borderColor = accentColor; }}
      onBlur={e => { commit(); e.currentTarget.style.borderColor = 'var(--gc-border)'; }}
    />
  );
}

export default function DateTimeInput({
  value, onChange, accentColor,
  placeholder = 'Pick date and time',
  size = 'md',
  defaultTime = '08:00',
}: Props) {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  const datePart = m ? m[1] : '';
  const timePart = m ? m[2] : '';

  if (!value) {
    const dims = size === 'sm'
      ? { padding: '5px 9px', fontSize: 12 }
      : { padding: 'calc(8.5px * var(--ui-scale, 1)) calc(11px * var(--ui-scale, 1))', fontSize: 'calc(12px * var(--ui-scale, 1))' as const };
    return (
      <button
        type="button"
        onClick={() => {
          const today = new Date().toISOString().slice(0, 10);
          onChange(`${today}T${defaultTime}`);
        }}
        style={{
          ...dims,
          border: '1px solid var(--gc-border)', borderRadius: 8,
          color: 'var(--gc-text-3)', background: 'var(--gc-surface)',
          cursor: 'pointer', textAlign: 'left',
          transition: 'border-color 150ms',
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = accentColor)}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
      >
        {placeholder}
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <DatePicker
        value={datePart}
        onChange={d => onChange(`${d}T${timePart || defaultTime}`)}
        headerColor={accentColor}
      />
      <TimeText
        value={timePart}
        onChange={t => onChange(`${datePart}T${t}`)}
        accentColor={accentColor}
        size={size}
      />
      <button
        type="button" onClick={() => onChange('')} title="Clear"
        style={{
          flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--gc-text-3)', fontSize: 18, lineHeight: 1, padding: '0 2px',
        }}
        onMouseEnter={e => (e.currentTarget.style.color = '#d93025')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-3)')}
      >×</button>
    </div>
  );
}
