'use client';

/**
 * CostBar — horizontal stacked bar where the FULL width represents
 * period revenue and each segment shows a cost bucket eating into it.
 * Whatever's left at the right side is margin. Hover a segment to see
 * the dollar / % detail.
 *
 * If costs exceed revenue (negative margin), segments are scaled to
 * sum to 100% width — the bar still fills — but the margin segment
 * collapses to 0px and its legend row turns red with the deficit.
 *
 * Lifted out of DashboardView so the /expenses workspace renders the
 * SAME bar (revenue vs per-bucket spend) instead of a lookalike.
 * Margin green / deficit red are status colors — segment palettes
 * must not reuse them.
 */

import { useState } from 'react';

function fmtFull(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n);
}

export function CostBar({
  revenue, segments,
}: {
  revenue: number;
  segments: Array<{ label: string; amount: number; color: string }>;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const totalCost = segments.reduce((s, x) => s + x.amount, 0);
  const margin    = revenue - totalCost;
  const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;
  const negative  = margin < 0;

  // Scale: when costs exceed revenue we'd overflow 100%. Clamp so the
  // bar still renders cleanly inside the card. Honest figures live in
  // the legend below.
  const totalForScale = Math.max(revenue, totalCost);
  const widthOf = (amount: number) => (totalForScale > 0 ? (amount / totalForScale) * 100 : 0);

  const marginSeg = {
    label: negative ? 'Deficit' : 'Margin',
    amount: margin,
    color:  negative ? '#c5221f' : '#1e8e3e',
  };
  const allSegs = [...segments, marginSeg];

  return (
    <div>
      <div
        className="relative h-12 flex rounded-md overflow-hidden"
        style={{ border: '1px solid var(--gc-border)' }}
      >
        {allSegs.map((s, i) => {
          const w = widthOf(Math.max(0, s.amount));
          if (w <= 0) return null;
          const pct = revenue > 0 ? (s.amount / revenue) * 100 : 0;
          return (
            <div
              key={s.label}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{
                width: `${w}%`,
                backgroundColor: s.color,
                opacity: hovered != null && hovered !== i ? 0.55 : 1,
                transition: 'opacity 150ms',
                cursor: 'pointer',
              }}
              className="flex items-center justify-center text-white text-[11px] font-semibold tracking-wide"
              title={`${s.label}: ${fmtFull(s.amount)} (${pct.toFixed(1)}% of revenue)`}
            >
              {w >= 10 ? (
                <span className="px-2 truncate">
                  {s.label} · {pct.toFixed(0)}%
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Legend / detail row — switches between summary and the
          currently-hovered segment's detail. */}
      {hovered != null && allSegs[hovered] ? (
        <div className="mt-3 flex items-center gap-2 text-[13px]">
          <span
            className="inline-block rounded-sm"
            style={{ width: 12, height: 12, backgroundColor: allSegs[hovered].color }}
          />
          <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {allSegs[hovered].label}
          </span>
          <span style={{ color: 'var(--gc-text-1)' }}>
            {fmtFull(allSegs[hovered].amount)}
          </span>
          <span style={{ color: 'var(--gc-text-3)' }}>
            ({revenue > 0 ? ((allSegs[hovered].amount / revenue) * 100).toFixed(1) : '0.0'}% of revenue)
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-x-5 gap-y-2 flex-wrap text-[12px]">
          {allSegs.map((s) => {
            const pct = revenue > 0 ? (s.amount / revenue) * 100 : 0;
            const isMarginRow = s.label === 'Margin' || s.label === 'Deficit';
            return (
              <div key={s.label} className="flex items-center gap-1.5">
                <span
                  className="inline-block rounded-sm"
                  style={{ width: 10, height: 10, backgroundColor: s.color }}
                />
                <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {s.label}
                </span>
                <span style={{ color: isMarginRow && negative ? '#c5221f' : 'var(--gc-text-2)' }}>
                  {fmtFull(s.amount)} ({pct.toFixed(1)}%)
                </span>
              </div>
            );
          })}
          {revenue > 0 ? (
            <div className="ml-auto text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              Total revenue: <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtFull(revenue)}</span>
              {' · '}
              <span style={{ color: negative ? '#c5221f' : '#1e8e3e' }}>
                {negative ? '−' : ''}{Math.abs(marginPct).toFixed(1)}% margin
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
