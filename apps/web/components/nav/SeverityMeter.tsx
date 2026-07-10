'use client';

/**
 * SeverityMeter — small horizontal bar visualizing a Motive
 * performance-event's derived severity. Fill percentage comes from the
 * server-computed severity_score (0–100), color from severity_level.
 * Tick marks show where the moderate and severe thresholds sit so a
 * dispatcher can eyeball how close this event is to the next bucket.
 *
 * All the math lives server-side in deriveSeverity — this component is
 * pure presentation. Renders nothing when the row has no severity data
 * (dashcam-only events sometimes fall through to null).
 */

import type { PerformanceEventRow } from '@fleetcal/types';

interface Props {
  event: Pick<PerformanceEventRow,
    'severity_level' | 'severity_score' | 'severity_display' | 'severity_metric'>;
}

export default function SeverityMeter({ event }: Props) {
  if (event.severity_score == null || event.severity_level == null) return null;

  const color = severityColor(event.severity_level);
  const fill = Math.max(0, Math.min(100, event.severity_score));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, color: 'var(--gc-text-2)' }}>
          {event.severity_metric ?? 'Severity'}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color, marginLeft: 'auto' }}>
          {event.severity_display ?? '—'}
        </span>
        <span
          style={{
            fontSize: 9.5, fontWeight: 700, color, letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          {event.severity_level}
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 8, borderRadius: 4,
          background: 'var(--gc-bg)',
          border: '1px solid var(--gc-border-light)',
          overflow: 'hidden',
        }}
      >
        {/* Fill */}
        <div
          style={{
            position: 'absolute', inset: 0,
            width: `${fill}%`,
            background: color,
            transition: 'width 200ms ease-out, background 150ms',
          }}
        />
        {/* Threshold marks — 33% = moderate boundary, ~100% = severe.
            Rendered as thin lines so the bar reads at a glance. */}
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: '33%', width: 1, background: 'rgba(0,0,0,0.15)' }} />
      </div>
    </div>
  );
}

export function severityColor(level: 'low' | 'moderate' | 'severe' | null): string {
  if (level === 'severe')   return '#dc2626';
  if (level === 'moderate') return '#f59e0b';
  return '#3b82f6';
}
