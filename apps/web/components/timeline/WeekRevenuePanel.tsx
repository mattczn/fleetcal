'use client';

/**
 * WeekRevenuePanel — shown when the user clicks the Week-total card in
 * Week view. Aggregates the week's P&L into a Big-Numbers card plus a
 * 7-row per-day breakdown table.
 *
 * Replaces the per-day RevenueAnalysisStrip + the timeline grid when
 * the user is zoomed out to "the week as a whole" — those views are
 * day-scoped and don't have a coherent week-scope rendering.
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

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDayLabel(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DOW[dt.getDay()]} ${MONTH[dt.getMonth()]} ${d}`;
}

interface Props {
  summary:    WeekSummary;
  assetColor: string;
  /** Click a day row to jump back into single-day view for that day. */
  onSelectDay: (dayKey: string) => void;
  fs:         (px: number) => number;
}

export default function WeekRevenuePanel({
  summary, assetColor, onSelectDay, fs,
}: Props) {
  const t = summary.weekTotal;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
          Week revenue analysis
        </span>
        <span style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
          · {summary.days[0]?.dayKey} – {summary.days[6]?.dayKey} · inbound attribution
        </span>
      </div>

      <div className="flex gap-3 items-stretch">
        {/* Big totals card on the left */}
        <div
          className="flex-shrink-0 rounded-lg p-4"
          style={{
            width:      280,
            background: 'var(--gc-surface-2)',
            border:     `2px solid ${assetColor}`,
          }}
        >
          <div className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
            Week total
          </div>
          <div className="font-semibold tabular-nums mt-2" style={{ color: 'var(--gc-text-1)', fontSize: fs(28) }}>
            {fmtMoney(t.totalRevenue)}
          </div>
          <div className="tabular-nums mt-0.5" style={{ color: '#1e8e3e', fontSize: fs(12) }}>
            {fmtRpm(t.dayRpm)} attributed
          </div>
          <div className="tabular-nums" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
            {fmtRpm(t.dayRpmTotal)} total · {fmtPct(t.deadheadPctOfDay)} dh
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-0.5" style={{ color: 'var(--gc-text-2)', fontSize: fs(11) }}>
            <span>Loads</span>
            <span className="text-right tabular-nums">{t.loadCount}</span>
            <span>Loaded</span>
            <span className="text-right tabular-nums">{fmtMi(t.loadedMiles)}</span>
            <span>Inbound dh</span>
            <span className="text-right tabular-nums">{fmtMi(t.inboundDhMiles)}</span>
            <span>Yard return</span>
            <span className="text-right tabular-nums">{fmtMi(t.yardReturnMiles)}</span>
            {t.unattributedMiles > 0 ? (
              <>
                <span style={{ color: 'var(--gc-text-3)' }}>Unattributed</span>
                <span className="text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>{fmtMi(t.unattributedMiles)}</span>
              </>
            ) : null}
            <span style={{ color: 'var(--gc-text-3)' }}>Total miles</span>
            <span className="text-right tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMi(t.totalMiles)}</span>
          </div>

          {t.totalDriverPay > 0 ? (
            <div className="mt-3 pt-3 grid grid-cols-2 gap-x-3 gap-y-0.5" style={{ borderTop: '1px dashed var(--gc-border)', color: 'var(--gc-text-2)', fontSize: fs(11) }}>
              <span>Driver pay</span>
              <span className="text-right tabular-nums">{fmtMoney(t.totalDriverPay)}</span>
              <span style={{ color: 'var(--gc-text-3)' }}>Net to truck</span>
              <span className="text-right tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(t.totalRevenue - t.totalDriverPay)}</span>
            </div>
          ) : null}
        </div>

        {/* Per-day table on the right */}
        <div
          className="flex-1 min-w-0 rounded-lg overflow-hidden"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}
        >
          <div
            className="grid border-b uppercase font-semibold tracking-wider"
            style={{
              gridTemplateColumns: '1.3fr 0.8fr 0.6fr 1fr 0.9fr 0.6fr',
              borderColor: 'var(--gc-border)',
              color: 'var(--gc-text-3)',
              fontSize: fs(10),
            }}
          >
            <div className="px-3 py-2">Day</div>
            <div className="px-2 py-2 text-right">Revenue</div>
            <div className="px-2 py-2 text-right">Loads</div>
            <div className="px-2 py-2 text-right">Miles</div>
            <div className="px-2 py-2 text-right">RPM</div>
            <div className="px-2 py-2 text-right">DH%</div>
          </div>
          {summary.days.map((d) => (
            <DayRow key={d.dayKey} day={d} onClick={() => onSelectDay(d.dayKey)} fs={fs} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayRow({
  day, onClick, fs,
}: {
  day:     WeekDaySummary;
  onClick: () => void;
  fs:      (px: number) => number;
}) {
  const empty = day.loadCount === 0 && day.totalMiles === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full grid text-left transition-colors hover:bg-black/[0.02]"
      style={{
        gridTemplateColumns: '1.3fr 0.8fr 0.6fr 1fr 0.9fr 0.6fr',
        borderTop: '1px solid var(--gc-border)',
        color: 'var(--gc-text-2)',
        fontSize: fs(12),
      }}
    >
      <div className="px-3 py-2 font-semibold" style={{ color: 'var(--gc-text-1)' }}>
        {fmtDayLabel(day.dayKey)}
      </div>
      {empty ? (
        <>
          <div className="px-2 py-2 text-right" style={{ color: 'var(--gc-text-3)' }}>—</div>
          <div className="px-2 py-2 text-right" style={{ color: 'var(--gc-text-3)' }}>—</div>
          <div className="px-2 py-2 text-right" style={{ color: 'var(--gc-text-3)' }}>—</div>
          <div className="px-2 py-2 text-right" style={{ color: 'var(--gc-text-3)' }}>—</div>
          <div className="px-2 py-2 text-right" style={{ color: 'var(--gc-text-3)' }}>—</div>
        </>
      ) : (
        <>
          <div className="px-2 py-2 text-right tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(day.totalRevenue)}</div>
          <div className="px-2 py-2 text-right tabular-nums">{day.loadCount}</div>
          <div className="px-2 py-2 text-right tabular-nums">{fmtMi(day.totalMiles)}</div>
          <div className="px-2 py-2 text-right tabular-nums">{fmtRpm(day.dayRpm)}</div>
          <div className="px-2 py-2 text-right tabular-nums">{fmtPct(day.deadheadPctOfDay)}</div>
        </>
      )}
    </button>
  );
}
