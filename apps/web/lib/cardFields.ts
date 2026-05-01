import type { CalendarEvent } from './types';

export type CardFieldKey =
  | 'time' | 'driver' | 'loadNum' | 'broker' | 'loadPrice' | 'driverPay'
  | 'refNums' | 'notes';

export interface CardFieldDef {
  key: CardFieldKey;
  label: string;
  render: (event: CalendarEvent, driverLabel?: string | null) => string | null;
}

export const CARD_FIELD_DEFS: CardFieldDef[] = [
  { key: 'time',      label: 'Time',       render: (e) => { const s = e.start.split('T')[1]?.slice(0,5); const en = e.end.split('T')[1]?.slice(0,5); return s && en ? `${fmt(s)}–${fmt(en)}` : null; } },
  { key: 'driver',    label: 'Driver',     render: (e, d) => d ?? e.driverName ?? null },
  { key: 'loadNum',   label: 'Load #',     render: (e) => e.loadNum ? `#${e.loadNum}` : null },
  { key: 'broker',    label: 'Broker',     render: (e) => e.broker ?? null },
  { key: 'loadPrice', label: 'Rate',       render: (e) => e.loadPrice != null ? `$${e.loadPrice.toLocaleString()}` : null },
  { key: 'driverPay', label: 'Driver Pay', render: (e) => e.driverPay != null ? `$${e.driverPay.toLocaleString()}` : null },
  { key: 'refNums',   label: 'Ref #',      render: (e) => e.refNums?.length ? e.refNums.map(r => r.label ? `${r.label} ${r.value}` : r.value).filter(Boolean).join('  ·  ') : null },
  { key: 'notes',     label: 'Notes',      render: (e) => e.notes ?? null },
];

export const DEFAULT_CARD_FIELDS: CardFieldKey[] = ['time', 'driver', 'loadNum', 'loadPrice'];

function fmt(t: string) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2,'0')}${ampm}`;
}
