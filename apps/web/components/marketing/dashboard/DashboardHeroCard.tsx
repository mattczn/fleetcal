'use client';

/**
 * DashboardHeroCard — interactive dashboard preview in the /product/dashboard
 * hero. A timeframe segmented control (Week / This Month / 30 Days / 90 Days
 * / YTD / Custom) rescales every KPI + the revenue-breakdown totals while
 * holding the ~30% payroll / 22% fuel / 48% margin mix constant. Illustrative
 * marketing figures — no data fetching.
 */
import { useState } from 'react';
import { DollarSign, Clock, Wallet, TrendingUp } from 'lucide-react';

const LABELS = ['Week', 'This Month', '30 Days', '90 Days', 'YTD', 'Custom'] as const;

type Frame = {
  range: string; rev: string; loads: string; avgTruck: string; avgLoad: string;
  payroll: string; finalized: string; total: string;
  payrollD: string; fuelD: string; marginD: string;
};

const FRAMES: Frame[] = [
  { range: 'Jun 6 – Jun 12, 2026',  rev: '$45.2K', loads: '53',    avgTruck: '$5.7K',  avgLoad: '$853', payroll: '$13.5K',  finalized: '1 week finalized',   total: '$45,205',    payrollD: '$13,477',  fuelD: '$9,950',   marginD: '$21,778' },
  { range: 'Jun 1 – Jun 30, 2026',  rev: '$194K',  loads: '228',   avgTruck: '$24.3K', avgLoad: '$851', payroll: '$57.8K',  finalized: '3 weeks finalized',  total: '$194,000',   payrollD: '$57,812',  fuelD: '$42,680',  marginD: '$93,508' },
  { range: 'May 14 – Jun 12, 2026', rev: '$192K',  loads: '226',   avgTruck: '$24.0K', avgLoad: '$850', payroll: '$57.2K',  finalized: '4 weeks finalized',  total: '$192,000',   payrollD: '$57,216',  fuelD: '$42,240',  marginD: '$92,544' },
  { range: 'Mar 15 – Jun 12, 2026', rev: '$578K',  loads: '681',   avgTruck: '$72.3K', avgLoad: '$849', payroll: '$172.2K', finalized: '12 weeks finalized', total: '$578,000',   payrollD: '$172,244', fuelD: '$127,160', marginD: '$278,596' },
  { range: 'Jan 1 – Jun 12, 2026',  rev: '$1.08M', loads: '1,272', avgTruck: '$135K',  avgLoad: '$849', payroll: '$321.8K', finalized: '23 weeks finalized', total: '$1,080,000', payrollD: '$321,840', fuelD: '$237,600', marginD: '$520,560' },
  { range: 'Jun 1 – Jun 20, 2026',  rev: '$129K',  loads: '152',   avgTruck: '$16.1K', avgLoad: '$849', payroll: '$38.4K',  finalized: '2 weeks finalized',  total: '$129,000',   payrollD: '$38,442',  fuelD: '$28,380',  marginD: '$62,178' },
];

function Kpi({ label, value, sub, Icon, chipBg, chipFg, finalized }: {
  label: string; value: string; sub: string;
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
  chipBg: string; chipFg: string; finalized?: boolean;
}) {
  return (
    <div style={{ background: '#fff', padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368' }}>{label}</span>
        <span style={{ width: 26, height: 26, borderRadius: 999, background: chipBg, display: 'grid', placeItems: 'center', flex: 'none' }}>
          <Icon size={13} style={{ color: chipFg }} strokeWidth={2.2} />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7 }}>
        <span className="font-display" style={{ fontWeight: 800, fontSize: 26, letterSpacing: '-0.02em', color: '#202124' }}>{value}</span>
        {finalized && <span style={{ fontSize: 10, fontWeight: 600, color: '#1e8e3e', background: '#e6f4ea', padding: '2px 7px', borderRadius: 999 }}>FINALIZED</span>}
      </div>
      <div style={{ fontSize: 11.5, color: '#5f6368', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

export default function DashboardHeroCard() {
  const [frame, setFrame] = useState(0);
  const f = FRAMES[frame];

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      {/* Header + timeframe control */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid #e8eaed', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <span className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124' }}>Dashboard</span>
          <div style={{ fontSize: 11, color: '#5f6368', marginTop: 1 }}>{f.range}</div>
        </div>
        <div className="db-scroll" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, background: '#eef1f4', borderRadius: 999, padding: 3, maxWidth: '100%', overflowX: 'auto' }}>
          {LABELS.map((label, i) => {
            const active = i === frame;
            return (
              <button
                key={label}
                type="button"
                onClick={() => setFrame(i)}
                className="font-display"
                style={{ fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all .15s', background: active ? '#fff' : 'transparent', color: active ? '#202124' : '#5f6368', boxShadow: active ? '0 1px 2px rgba(60,64,67,.2)' : 'none' }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#e8eaed' }}>
        <Kpi label="Total Revenue" value={f.rev} sub={`${f.loads} loads in period`} Icon={DollarSign} chipBg="#e8f0fe" chipFg="#1a73e8" />
        <Kpi label="Avg / Truck" value={f.avgTruck} sub="8 active trucks" Icon={Clock} chipBg="#fef0e6" chipFg="#f59e0b" />
        <Kpi label="Total Payroll" value={f.payroll} sub={f.finalized} Icon={Wallet} chipBg="#f3e8fd" chipFg="#6941c6" finalized />
        <Kpi label="Avg / Load" value={f.avgLoad} sub={`across ${f.loads} loads`} Icon={TrendingUp} chipBg="#e6f4ea" chipFg="#1e8e3e" />
      </div>

      {/* Revenue breakdown */}
      <div style={{ padding: '16px 18px', borderTop: '1px solid #e8eaed' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9, gap: 10, flexWrap: 'wrap' }}>
          <span className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>Revenue Breakdown</span>
          <span style={{ fontSize: 12, color: '#5f6368' }}>Total <strong style={{ color: '#202124' }}>{f.total}</strong> · <span style={{ color: '#1e8e3e', fontWeight: 600 }}>48.2% margin</span></span>
        </div>
        <div style={{ display: 'flex', height: 30, borderRadius: 8, overflow: 'hidden' }}>
          <div className="font-display" style={{ width: '29.8%', background: '#6941c6', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: 11 }}>Payroll</div>
          <div className="font-display" style={{ width: '22%', background: '#f97316', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: 11 }}>Fuel</div>
          <div className="font-display" style={{ flex: 1, background: '#1e8e3e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: 12 }}>Margin · 48%</div>
        </div>
        <div style={{ display: 'flex', gap: 18, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#5f6368' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: '#6941c6', marginRight: 5 }} />Payroll {f.payrollD} (29.8%)</span>
          <span style={{ fontSize: 12, color: '#5f6368' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: '#f97316', marginRight: 5 }} />Fuel {f.fuelD} (22.0%)</span>
          <span style={{ fontSize: 12, color: '#5f6368' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: '#1e8e3e', marginRight: 5 }} />Margin {f.marginD} (48.2%)</span>
        </div>
      </div>
    </div>
  );
}
