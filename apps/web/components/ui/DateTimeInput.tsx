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

import { useState } from 'react';
import DatePicker from '@/components/calendar/DatePicker';
import TimePicker from '@/components/calendar/TimePicker';
import { todayDateKeyInTz } from '@/lib/time-utils';
import { useCalendarStore } from '@/store/useCalendarStore';

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

/** Thin wrapper around TimePicker — translates the sm/md size variant
 *  into the picker's width + font overrides so the trigger lines up
 *  with the sibling DatePicker at the right scale. */
function TimeText({ value, onChange, accentColor, size }: {
  value: string; onChange: (v: string) => void; accentColor: string; size: 'sm' | 'md';
}) {
  if (size === 'sm') {
    return (
      <TimePicker value={value} onChange={onChange} headerColor={accentColor}
        inputWidth={56}
        inputStyle={{ padding: '5px 7px', fontSize: 12 }} />
    );
  }
  return (
    <TimePicker value={value} onChange={onChange} headerColor={accentColor} />
  );
}

export default function DateTimeInput({
  value, onChange, accentColor,
  placeholder = 'Pick date and time',
  size = 'md',
  defaultTime = '08:00',
}: Props) {
  // Org timezone for the "today" default in the empty-state button.
  // Without this, the button primed UTC date — wrong for any user
  // east of London before noon UTC or west after, so a Mountain Time
  // dispatcher clicking "Today" near midnight got tomorrow's date.
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);
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
          const today = todayDateKeyInTz(calendarTimezone);
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

  // For the compact (sm) variant, override both the DatePicker
  // trigger's size AND its display string. The default trigger uses
  // its own internal 13.5px font and renders "Sat, Jun 6, 2026" —
  // which dominates an inline form row. We tighten to 12px and drop
  // the weekday + add a short month, giving "Jun 6, 2026" at the
  // same visual weight as the time field next to it.
  const dpButtonStyle = size === 'sm'
    ? { fontSize: 12, padding: '5px 9px' }
    : undefined;
  const dpContainerStyle = size === 'sm'
    ? { flex: '0 0 auto' }   // don't eat the whole row width
    : undefined;
  const dpDisplay = size === 'sm' ? formatCompactDate(datePart) : undefined;

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <DatePicker
        value={datePart}
        onChange={d => onChange(`${d}T${timePart || defaultTime}`)}
        headerColor={accentColor}
        displayText={dpDisplay}
        buttonStyle={dpButtonStyle}
        containerStyle={dpContainerStyle}
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

/** "2026-06-06" → "Jun 6, 2026". No weekday — keeps the sm
 *  trigger button compact next to its sibling time input. */
function formatCompactDate(v: string): string {
  if (!v) return '';
  const [y, m, d] = v.split('-').map(Number);
  if (!y || !m || !d) return v;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}
