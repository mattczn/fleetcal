'use client';

/**
 * ReportBuilderCard — interactive "Custom Loads Report" builder for the
 * /product/dashboard reports section. Column chips toggle on click; the
 * Pickup/Delivery date-basis is a mutually-exclusive segmented toggle.
 * Illustrative — no data, no export.
 */
import { useState } from 'react';
import { Filter, ChevronDown, Download } from 'lucide-react';

const CRITERIA: ReadonlyArray<[string, string]> = [
  ['Date range', 'Jun 6 - Jun 12, 2026'],
  ['Customer', 'Arrive, TQL +3'],
  ['Driver', 'All drivers'],
  ['Truck', 'All 8 trucks'],
  ['Status', 'Delivered'],
];

const COLS = ['Load #', 'Customer', 'Driver', 'Truck', 'Driver Pay', 'Miles', 'Status', 'Accessorials'] as const;
const DEFAULT_ON: Record<string, boolean> = { 'Load #': true, 'Customer': true, 'Driver': true, 'Truck': true, 'Driver Pay': true };

function CriteriaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: '#fff', border: '1px solid #dadce0', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: '#202124' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
        <ChevronDown size={13} style={{ color: '#9aa0a6', flex: 'none' }} strokeWidth={2.2} />
      </div>
    </div>
  );
}

export default function ReportBuilderCard() {
  const [cols, setCols] = useState<Record<string, boolean>>(DEFAULT_ON);
  const [billing, setBilling] = useState<'Pickup' | 'Delivery'>('Pickup');

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '18px 22px', borderBottom: '1px solid #e8eaed', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, background: '#e8f0fe', color: '#1a73e8', display: 'grid', placeItems: 'center', flex: 'none' }}>
          <Filter size={17} strokeWidth={2.2} />
        </span>
        <div>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 16, color: '#202124' }}>Custom Loads Report</div>
          <div style={{ fontSize: 12.5, color: '#5f6368' }}>Set your filters, pick the columns, export.</div>
        </div>
      </div>

      {/* Criteria */}
      <div className="grid grid-cols-2 sm:grid-cols-3" style={{ padding: '18px 22px', gap: 14 }}>
        {CRITERIA.map(([label, value]) => <CriteriaField key={label} label={label} value={value} />)}
        <div>
          <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 6 }}>Filter by</div>
          <div style={{ display: 'inline-flex', background: '#eef1f4', borderRadius: 8, padding: 3 }}>
            {(['Pickup', 'Delivery'] as const).map((b) => {
              const active = billing === b;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBilling(b)}
                  className="font-display"
                  style={{ fontSize: 12.5, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', transition: 'all .15s', background: active ? '#1a73e8' : 'transparent', color: active ? '#fff' : '#5f6368' }}
                >
                  {b}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Column chips */}
      <div style={{ padding: '2px 22px 18px' }}>
        <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 9 }}>Columns · tap to toggle</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {COLS.map((c) => {
            const active = !!cols[c];
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCols((prev) => ({ ...prev, [c]: !prev[c] }))}
                className="font-display"
                style={{ fontSize: 12.5, fontWeight: 600, padding: '7px 13px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all .15s', background: active ? '#e8f0fe' : '#fff', color: active ? '#1967d2' : '#5f6368', border: `1px solid ${active ? '#1a73e8' : '#dadce0'}` }}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>

      {/* Footer totals + export */}
      <div style={{ padding: '18px 22px', borderTop: '1px solid #e8eaed', background: '#fafbfc', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 28 }}>
          <div><div className="font-display" style={{ fontWeight: 800, fontSize: 20, color: '#202124', letterSpacing: '-0.01em' }}>53</div><div style={{ fontSize: 11.5, color: '#5f6368', marginTop: 2 }}>loads</div></div>
          <div><div className="font-display" style={{ fontWeight: 800, fontSize: 20, color: '#202124', letterSpacing: '-0.01em' }}>$45,205</div><div style={{ fontSize: 11.5, color: '#5f6368', marginTop: 2 }}>total</div></div>
          <div><div className="font-display" style={{ fontWeight: 800, fontSize: 20, color: '#1e8e3e', letterSpacing: '-0.01em' }}>$13,477</div><div style={{ fontSize: 11.5, color: '#5f6368', marginTop: 2 }}>driver pay</div></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #dadce0', borderRadius: 8, padding: '9px 14px', fontSize: 13, fontWeight: 600, color: '#3c4043', background: '#fff', cursor: 'pointer' }}>
            <Download size={14} strokeWidth={2.2} /> CSV
          </button>
          <button type="button" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #1a73e8', borderRadius: 8, padding: '9px 14px', fontSize: 13, fontWeight: 600, color: '#fff', background: '#1a73e8', cursor: 'pointer' }}>
            <Download size={14} strokeWidth={2.2} /> Excel
          </button>
        </div>
      </div>
    </div>
  );
}
