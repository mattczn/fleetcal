'use client';

/**
 * ModifyPayCard — interactive "Modify pay %" card for the /product/payroll
 * Default-pay-settings feature. Clicking a percentage chip recomputes the
 * driver pay (linehaul × pct) live; a "Reset to default" link appears when
 * the percentage isn't the org default (30%). Illustrative — no data.
 */
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';

const LINEHAUL = 575;
const OPTS = [25, 30, 35, 40] as const;
const DEFAULT_PCT = 30;
const money = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ModifyPayCard() {
  const [pct, setPct] = useState<number>(DEFAULT_PCT);
  const driverPay = (LINEHAUL * pct) / 100;
  const showReset = pct !== DEFAULT_PCT;

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #e8eaed', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5f6368' }}>Driver pay</span>
        <span style={{ fontSize: 13, color: '#1a73e8', fontWeight: 600 }}>FreightTec · #6165015</span>
      </div>
      <div style={{ padding: '22px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: '#5f6368', marginBottom: 4 }}>Linehaul</div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 24, color: '#202124' }}>{money(LINEHAUL)}</div>
          </div>
          <div style={{ fontSize: 22, color: '#cdd2d8' }}>×</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#5f6368', marginBottom: 4 }}>Pay %</div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 24, color: '#1a73e8' }}>{pct}%</div>
          </div>
          <div style={{ fontSize: 22, color: '#cdd2d8' }}>=</div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: '#5f6368', marginBottom: 4 }}>Driver pay</div>
            <div className="font-display" style={{ fontWeight: 800, fontSize: 26, color: '#1e8e3e', letterSpacing: '-0.01em' }}>{money(driverPay)}</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#5f6368', marginRight: 2 }}>Adjust:</span>
          {OPTS.map((v) => {
            const active = v === pct;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setPct(v)}
                className="font-display"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  padding: '7px 13px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  transition: 'all .15s',
                  background: active ? '#1a73e8' : '#fff',
                  color: active ? '#fff' : '#3c4043',
                  border: `1px solid ${active ? '#1a73e8' : '#dadce0'}`,
                }}
              >
                {v}%
              </button>
            );
          })}
          {showReset && (
            <button
              type="button"
              onClick={() => setPct(DEFAULT_PCT)}
              style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6368', background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 4px' }}
            >
              <RotateCcw size={13} strokeWidth={2.4} />
              Reset to default
            </button>
          )}
        </div>

        <div style={{ marginTop: 16, fontSize: 12.5, color: '#5f6368', background: '#f0f9ff', border: '1px solid #e0f2fe', borderRadius: 10, padding: '10px 13px' }}>
          Your org default is <strong style={{ color: '#0369a1' }}>30%</strong>. It&apos;s applied to every load automatically. Override it on this load, or per week on the payroll page.
        </div>
      </div>
    </div>
  );
}
