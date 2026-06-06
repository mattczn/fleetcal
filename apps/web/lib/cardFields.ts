import type { CalendarEvent, Customer } from './types';
import { displayBrokerName } from './customerMatch';

export type CardFieldKey =
  | 'time' | 'driver' | 'loadNum' | 'broker' | 'loadPrice' | 'totalBillable' | 'driverPay'
  | 'refNums' | 'notes';

export interface CardFieldRenderCtx {
  driverLabel?: string | null;
  customers?:   Customer[];
}

export interface CardFieldDef {
  key: CardFieldKey;
  label: string;
  render: (event: CalendarEvent, ctx?: CardFieldRenderCtx) => string | null;
}

export const CARD_FIELD_DEFS: CardFieldDef[] = [
  { key: 'time',      label: 'Time',       render: (e) => { const s = e.start.split('T')[1]?.slice(0,5); const en = e.end.split('T')[1]?.slice(0,5); return s && en ? `${fmt(s)}–${fmt(en)}` : null; } },
  { key: 'driver',    label: 'Driver',     render: (e, ctx) => ctx?.driverLabel ?? e.driverName ?? null },
  { key: 'loadNum',   label: 'Load #',     render: (e) => e.loadNum ? `#${e.loadNum}` : null },
  { key: 'broker',    label: 'Customer',   render: (e, ctx) => displayBrokerName(e.broker, ctx?.customers ?? []) || null },
  { key: 'loadPrice', label: 'Linehaul',   render: (e) => e.loadPrice != null ? `$${e.loadPrice.toLocaleString()}` : null },
  // Total billable (linehaul + billable accessorials). Renders ONLY when
  // it differs from loadPrice — i.e., when there's at least one billable
  // accessorial with amount > 0. When equal, the row collapses out so
  // the chip isn't cluttered with redundant numbers.
  { key: 'totalBillable', label: 'Total', render: (e) => (
      e.totalBillable != null
        && e.loadPrice != null
        && Math.abs(e.totalBillable - e.loadPrice) >= 0.005
        ? `$${e.totalBillable.toLocaleString()}`
        : null
    ) },
  { key: 'driverPay', label: 'Driver Pay', render: (e) => e.driverPay != null ? `$${e.driverPay.toLocaleString()}` : null },
  { key: 'refNums',   label: 'Ref #',      render: (e) => e.refNums?.length ? e.refNums.map(r => r.label ? `${r.label} ${r.value}` : r.value).filter(Boolean).join('  ·  ') : null },
  { key: 'notes',     label: 'Notes',      render: (e) => e.notes ?? null },
];

export const DEFAULT_CARD_FIELDS: CardFieldKey[] = ['time', 'driver', 'loadNum', 'loadPrice', 'totalBillable'];

function fmt(t: string) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2,'0')}${ampm}`;
}
