'use client';

/**
 * PieChart — SVG donut with hover detail in the center hole.
 *
 * Lifted out of DashboardView (Revenue by Customer card) so the
 * /expenses workspace renders the same chart for expenses-by-bucket.
 * Slices dim on hover of a sibling; the hovered slice's label +
 * dollar value appear in the hole. Single-slice input renders as a
 * plain ring (no gap math).
 */

import { useState } from 'react';

export interface PieSlice { value: number; color: string; label: string }

export function PieChart({ slices, size = 160, showLabels = false }: { slices: PieSlice[]; size?: number; showLabels?: boolean }) {
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  const [hovered, setHovered] = useState<number | null>(null);
  if (total === 0) return null;

  const cx = size / 2, cy = size / 2;
  const R  = size * 0.42;
  const ri = size * 0.24;
  const labelR = R + size * 0.13;
  const GAP = slices.length > 1 ? 0.018 : 0;

  let cursor = -Math.PI / 2;
  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const hoveredSlice = hovered !== null ? slices[hovered] : null;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ display: 'block', overflow: 'visible' }}>
      {slices.length === 1 ? (
        <>
          <circle cx={cx} cy={cy} r={R} fill={slices[0].color} />
          <circle cx={cx} cy={cy} r={ri} fill="var(--gc-surface)" />
        </>
      ) : (
        slices.map((slice, i) => {
          const fraction = slice.value / total;
          const sweep    = fraction * 2 * Math.PI - GAP;
          const start    = cursor + GAP / 2;
          const end      = start + sweep;
          const mid      = start + sweep / 2;
          cursor        += fraction * 2 * Math.PI;

          const x1 = cx + R  * Math.cos(start), y1 = cy + R  * Math.sin(start);
          const x2 = cx + R  * Math.cos(end),   y2 = cy + R  * Math.sin(end);
          const x3 = cx + ri * Math.cos(end),   y3 = cy + ri * Math.sin(end);
          const x4 = cx + ri * Math.cos(start), y4 = cy + ri * Math.sin(start);
          const large = sweep > Math.PI ? 1 : 0;
          const d = `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${ri} ${ri} 0 ${large} 0 ${x4} ${y4} Z`;

          const lx  = cx + labelR * Math.cos(mid);
          const ly  = cy + labelR * Math.sin(mid);
          const fraction100 = Math.round(fraction * 100);
          const isHovered = hovered === i;

          return (
            <g key={i}>
              <path d={d} fill={slice.color}
                style={{ transition: 'opacity 120ms', opacity: hovered !== null && !isHovered ? 0.45 : 1, cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
              {showLabels && fraction100 >= 10 && (
                <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
                  fontSize={size * 0.065} fontWeight="700" fill={slice.color}
                  style={{ pointerEvents: 'none' }}>
                  {slice.label.length > 12 ? slice.label.slice(0, 11) + '…' : slice.label}
                </text>
              )}
            </g>
          );
        })
      )}

      {/* Center hole label — shows on hover */}
      {hoveredSlice ? (
        <>
          <text x={cx} y={cy - size * 0.055} textAnchor="middle" dominantBaseline="central"
            fontSize={size * 0.072} fontWeight="700" style={{ pointerEvents: 'none' }}
            fill={hoveredSlice.color}>
            {hoveredSlice.label.length > 14 ? hoveredSlice.label.slice(0, 13) + '…' : hoveredSlice.label}
          </text>
          <text x={cx} y={cy + size * 0.1} textAnchor="middle" dominantBaseline="central"
            fontSize={size * 0.062} fontWeight="600" style={{ pointerEvents: 'none' }}
            fill="var(--gc-text-2)">
            {moneyFmt.format(hoveredSlice.value)}
          </text>
        </>
      ) : null}
    </svg>
  );
}
