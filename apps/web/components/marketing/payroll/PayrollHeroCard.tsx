'use client';

/**
 * PayrollHeroCard — the weekly-payroll summary card in the /product/payroll
 * hero. Two KPI figures (Total Weekly Gross, Total Driver Pay) and the
 * "payroll as % of revenue" number count up from 0 over ~1200ms on first
 * scroll-into-view (ease-out cubic), and the % progress bar animates its
 * width 0 → 29.9%. Honors prefers-reduced-motion by jumping straight to the
 * final values. Numbers are illustrative marketing copy, not live data.
 *
 * The count-up writes to refs (textContent / style.width) rather than React
 * state so the 60fps animation doesn't thrash re-renders.
 */
import { useEffect, useRef } from 'react';
import { Check, Download } from 'lucide-react';

const GROSS = 45205;
const PAY = 13534.5;
const PCT = 29.9;
const money = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PayrollHeroCard() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const grossRef = useRef<HTMLDivElement | null>(null);
  const payRef = useRef<HTMLDivElement | null>(null);
  const pctRef = useRef<HTMLSpanElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const setFinal = () => {
      if (grossRef.current) grossRef.current.textContent = money(GROSS);
      if (payRef.current) payRef.current.textContent = money(PAY);
      if (pctRef.current) pctRef.current.textContent = PCT.toFixed(1) + '%';
    };

    const run = () => {
      if (ran.current) return;
      ran.current = true;
      // Grow the % bar — CSS transition (set inline) does the easing.
      if (barRef.current) {
        if (reduce) barRef.current.style.transition = 'none';
        barRef.current.style.width = PCT + '%';
      }
      if (reduce) { setFinal(); return; }
      const dur = 1200;
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        if (grossRef.current) grossRef.current.textContent = money(GROSS * e);
        if (payRef.current) payRef.current.textContent = money(PAY * e);
        if (pctRef.current) pctRef.current.textContent = (PCT * e).toFixed(1) + '%';
        if (p < 1) requestAnimationFrame(tick);
        else setFinal();
      };
      requestAnimationFrame(tick);
    };

    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.95) { run(); return; }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) { run(); obs.disconnect(); return; }
        }
      },
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <div
        style={{
          background: '#fff',
          border: '1px solid #e8eaed',
          borderRadius: 20,
          boxShadow: 'var(--shadow-soft)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid #e8eaed', gap: 12 }}>
          <div>
            <div className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#5f6368' }}>Weekly payroll</div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 18, color: '#202124', marginTop: 3 }}>Jun 6 – Jun 12, 2026</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#1e8e3e', background: '#e6f4ea', padding: '6px 12px', borderRadius: 999, whiteSpace: 'nowrap' }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: '#1e8e3e' }} />
            Ready to finalize
          </span>
        </div>

        {/* KPI tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#e8eaed' }}>
          <div style={{ background: '#fff', padding: 22 }}>
            <div className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368' }}>Total Weekly Gross</div>
            <div ref={grossRef} className="font-display" style={{ fontWeight: 800, fontSize: 34, letterSpacing: '-0.02em', color: '#202124', marginTop: 8 }}>{money(GROSS)}</div>
          </div>
          <div style={{ background: '#fff', padding: 22 }}>
            <div className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368' }}>Total Driver Pay</div>
            <div ref={payRef} className="font-display" style={{ fontWeight: 800, fontSize: 34, letterSpacing: '-0.02em', color: '#1e8e3e', marginTop: 8 }}>{money(PAY)}</div>
          </div>
        </div>

        {/* % of revenue + bar */}
        <div style={{ padding: '18px 22px', borderTop: '1px solid #e8eaed' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
            <span style={{ fontSize: 13, color: '#5f6368' }}>Payroll as % of revenue</span>
            <span ref={pctRef} className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#1e8e3e' }}>{PCT.toFixed(1)}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: '#eef1f4', overflow: 'hidden' }}>
            <span ref={barRef} style={{ display: 'block', height: '100%', width: '0%', borderRadius: 999, background: 'linear-gradient(90deg,#34a853,#1e8e3e)', transition: 'width 1.1s cubic-bezier(.2,.7,.3,1)' }} />
          </div>
          <div style={{ display: 'flex', gap: 26, marginTop: 16 }}>
            <div><span className="font-display" style={{ fontWeight: 700, fontSize: 17, color: '#202124' }}>7</span> <span style={{ fontSize: 13, color: '#5f6368' }}>drivers</span></div>
            <div><span className="font-display" style={{ fontWeight: 700, fontSize: 17, color: '#202124' }}>53</span> <span style={{ fontSize: 13, color: '#5f6368' }}>loads</span></div>
          </div>
        </div>

        {/* Footer strip */}
        <div style={{ padding: '16px 22px', borderTop: '1px solid #e8eaed', background: '#f8fbf9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: '#5f6368' }}>All 53 loads auto-filled from the calendar</span>
          <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: '#1e8e3e', color: '#fff', fontWeight: 600, fontSize: 14, padding: '11px 17px', borderRadius: 999, boxShadow: 'var(--shadow-3)', whiteSpace: 'nowrap' }}>
            <span style={{ width: 20, height: 20, borderRadius: 999, background: 'rgba(255,255,255,.22)', display: 'grid', placeItems: 'center' }}>
              <Check size={12} strokeWidth={3} style={{ color: '#fff' }} />
            </span>
            Finalize · $13,534.50
          </span>
        </div>
      </div>

      {/* "Pay stub ready" badge — pops out of the card's top-right corner */}
      <div
        className="hidden sm:flex"
        style={{ position: 'absolute', top: -18, right: -18, zIndex: 4, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: 'var(--shadow-3)', padding: '12px 15px', alignItems: 'center', gap: 10 }}
      >
        <span style={{ width: 30, height: 30, borderRadius: 999, background: '#e8f0fe', display: 'grid', placeItems: 'center' }}>
          <Download size={14} style={{ color: '#1a73e8' }} strokeWidth={2.4} />
        </span>
        <div>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>Pay stub ready</div>
          <div style={{ fontSize: 11, color: '#5f6368' }}>PDF per driver</div>
        </div>
      </div>
    </div>
  );
}
