'use client';

/**
 * DeferCard — interactive "Defer pay" card for the /product/payroll
 * Defer feature. Pick a future week and Defer → the control swaps to a
 * purple confirmation showing the chosen week; Undo returns to the
 * default state. Illustrative — no data, no network.
 */
import { useState } from 'react';
import { CornerDownRight, RotateCcw } from 'lucide-react';

const WEEKS = ['Jun 13 – Jun 19', 'Jun 20 – Jun 26', 'Jun 27 – Jul 3', 'Jul 4 – Jul 10'] as const;

export default function DeferCard() {
  const [deferred, setDeferred] = useState(false);
  const [week, setWeek] = useState(0);

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #e8eaed', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5f6368' }}>This week · Jun 6 – Jun 12</span>
        <span style={{ fontSize: 12, color: '#5f6368' }}>Sat–Fri cutoff</span>
      </div>

      {/* Load row */}
      <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 120 }}>
          <div style={{ fontSize: 13, color: '#3c4043' }}>Thu, Jun 11</div>
          <span style={{ display: 'inline-block', marginTop: 4, fontSize: 11, fontWeight: 600, color: '#3c4043', background: '#eef1f4', padding: '3px 9px', borderRadius: 999 }}>Both</span>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1a73e8' }}>FreightTec: Carrollton, TX → Sanger, TX</div>
          <div style={{ fontSize: 12, color: '#5f6368', marginTop: 2 }}>#4764705 · 37 mi · $575.00</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 16, color: '#202124' }}>$172.50</div>
          <div style={{ fontSize: 11, color: '#5f6368' }}>30%</div>
        </div>
      </div>

      {/* Defer control / result */}
      <div style={{ padding: '16px 20px', borderTop: '1px solid #e8eaed', background: '#fafbfc' }}>
        {deferred ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap' }}>
            <span style={{ width: 34, height: 34, borderRadius: 999, background: '#6941c61a', color: '#6941c6', display: 'grid', placeItems: 'center', flex: 'none' }}>
              <CornerDownRight size={16} strokeWidth={2.4} />
            </span>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#202124' }}>Deferred to {WEEKS[week]}</div>
              <div style={{ fontSize: 12, color: '#6941c6' }}>$172.50 moved out of this week · paired +/− adjustment written</div>
            </div>
            <button
              type="button"
              onClick={() => { setDeferred(false); setWeek(0); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#6941c6', background: '#6941c61a', border: 'none', borderRadius: 999, padding: '9px 16px', cursor: 'pointer' }}
            >
              <RotateCcw size={14} strokeWidth={2.4} />
              Undo
            </button>
          </div>
        ) : (
          <div>
            <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 7 }}>Defer load to week</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <select
                value={week}
                onChange={(e) => setWeek(Number(e.target.value))}
                className="font-sys"
                style={{ flex: 1, minWidth: 180, height: 42, border: '1px solid #dadce0', background: '#fff', color: '#202124', borderRadius: 10, padding: '0 12px', fontSize: 14, cursor: 'pointer' }}
              >
                {WEEKS.map((label, i) => (
                  <option key={label} value={i}>{label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setDeferred(true)}
                className="font-display"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#1a73e8', color: '#fff', fontWeight: 600, fontSize: 14, border: 'none', borderRadius: 10, padding: '0 20px', height: 42, cursor: 'pointer', boxShadow: 'var(--shadow-1)' }}
              >
                <CornerDownRight size={15} strokeWidth={2.4} />
                Defer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
