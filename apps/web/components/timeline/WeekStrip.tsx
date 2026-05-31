'use client';

/**
 * WeekStrip — horizontal row of 7 day-cards (Sat → Fri) showing per-day
 * P&L plus a "Week total" card on the right. Sits above the Revenue
 * Analysis row on the asset-timeline page.
 *
 * Clicking any day-card sets dayKey; the rest of the page re-renders
 * for the selected day using the same single-day infrastructure. The
 * active day's card gets a 2px asset-color border + faint tint so it's
 * obvious which day is in focus.
 */

import type { WeekSummary, WeekDaySummary } from '@/lib/railway';

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtRpm(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}/mi`;
}
function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}
function fmtMi(n: number): string {
  return `${n.toFixed(0)}mi`;
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Pretty header for a dayKey: "Sat, May 30". */
function fmtDayHeader(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DOW_LABELS[dt.getDay()]}, ${MONTH_LABELS[dt.getMonth()]} ${d}`;
}

interface Props {
  summary:     WeekSummary;
  activeDayKey: string;
  todayKey:    string;
  assetColor:  string;
  onSelectDay: (dayKey: string) => void;
  fs:          (px: number) => number;
}

export default function WeekStrip({
  summary, activeDayKey, todayKey, assetColor, onSelectDay, fs,
}: Props) {
  return (
    <div className="mt-1 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
          Week
        </span>
        <span style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
          · {summary.days[0]?.dayKey ?? '?'} – {summary.days[6]?.dayKey ?? '?'} · {summary.weekTotal.loadCount} load{summary.weekTotal.loadCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {summary.days.map((d) => (
          <DayCard
            key={d.dayKey}
            day={d}
            isActive={d.dayKey === activeDayKey}
            isToday={d.dayKey === todayKey}
            assetColor={assetColor}
            onClick={() => onSelectDay(d.dayKey)}
            fs={fs}
          />
        ))}
        <WeekTotalCard total={summary.weekTotal} fs={fs} />
      </div>
    </div>
  );
}

function DayCard({
  day, isActive, isToday, assetColor, onClick, fs,
}: {
  day:        WeekDaySummary;
  isActive:   boolean;
  isToday:    boolean;
  assetColor: string;
  onClick:    () => void;
  fs:         (px: number) => number;
}) {
  const empty = day.loadCount === 0 && day.totalMiles === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-shrink-0 rounded-lg p-2.5 text-left transition-colors"
      style={{
        width:      140,
        background: isActive ? `${assetColor}1a` : 'var(--gc-surface)',
        border:     isActive ? `2px solid ${assetColor}` : '1px solid var(--gc-border)',
        cursor:     'pointer',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold" style={{ color: 'var(--gc-text-1)', fontSize: fs(11) }}>
          {fmtDayHeader(day.dayKey)}
        </span>
        {isToday ? (
          <span className="uppercase tracking-wider font-bold" style={{ color: assetColor, fontSize: fs(8) }}>
            TODAY
          </span>
        ) : null}
      </div>
      {empty ? (
        <div className="py-2" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
          —
        </div>
      ) : (
        <>
          <div className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)', fontSize: fs(15) }}>
            {fmtMoney(day.totalRevenue)}
          </div>
          <div className="tabular-nums mt-0.5" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
            {day.loadCount} load{day.loadCount === 1 ? '' : 's'} · {fmtRpm(day.dayRpm)}
          </div>
          <div className="tabular-nums" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
            {fmtMi(day.totalMiles)} · {fmtPct(day.deadheadPctOfDay)} dh
          </div>
        </>
      )}
    </button>
  );
}

function WeekTotalCard({
  total, fs,
}: {
  total: WeekDaySummary;
  fs:    (px: number) => number;
}) {
  return (
    <div
      className="flex-shrink-0 rounded-lg p-2.5"
      style={{
        width:      160,
        background: 'var(--gc-surface-2)',
        border:     '1px solid var(--gc-border)',
      }}
    >
      <div className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
        Week total
      </div>
      <div className="font-semibold tabular-nums mt-1" style={{ color: 'var(--gc-text-1)', fontSize: fs(17) }}>
        {fmtMoney(total.totalRevenue)}
      </div>
      <div className="tabular-nums mt-0.5" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
        {total.loadCount} load{total.loadCount === 1 ? '' : 's'} · {fmtRpm(total.dayRpm)}
      </div>
      <div className="tabular-nums" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
        {fmtMi(total.totalMiles)} · {fmtPct(total.deadheadPctOfDay)} dh
      </div>
      {total.totalDriverPay > 0 ? (
        <div className="tabular-nums mt-1 pt-1" style={{ color: 'var(--gc-text-3)', fontSize: fs(10), borderTop: '1px dashed var(--gc-border)' }}>
          Net: {fmtMoney(total.totalRevenue - total.totalDriverPay)}
        </div>
      ) : null}
    </div>
  );
}
