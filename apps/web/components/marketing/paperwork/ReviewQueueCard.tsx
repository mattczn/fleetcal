'use client';

/**
 * ReviewQueueCard — interactive review-queue demo for /product/paperwork.
 * Walks three sample delivered loads, each with a release verdict and a
 * verification checklist. Release for invoicing [R] (only on a ready load),
 * Flag [F], or Skip [→] advances to the next load; after the third a "Queue
 * clear" summary shows the counts. Keyboard shortcuts R / F / → are armed
 * only while the pointer is over the card (and ignore typing in inputs).
 * Illustrative — no data.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Flag, Clock, X, RotateCcw, AlertCircle } from 'lucide-react';

type Verdict = 'ready' | 'blocked' | 'pending';
type Result = 'released' | 'flagged' | 'skipped' | null;
type VRow = { label: string; status: string; ok: true | false | 'warn' };
type Load = { title: string; broker: string; id: string; value: string; age: string; verdict: Verdict; vrows: VRow[] };

const LOADS: Load[] = [
  {
    title: 'Arrive: Lancaster, TX to Locust Grove, GA', broker: 'Arrive', id: '#9024891', value: '$2,050.00', age: '3 days old', verdict: 'ready',
    vrows: [
      { label: 'Rate confirmation', status: 'Present', ok: true },
      { label: 'POD uploaded', status: 'Present', ok: true },
    ],
  },
  {
    title: 'TQL: Fort Worth, TX to Garland, TX', broker: 'TQL', id: '#8649331', value: '$615.00', age: '14 days old', verdict: 'blocked',
    vrows: [
      { label: 'Rate confirmation', status: 'Present', ok: true },
      { label: 'POD uploaded', status: 'Missing', ok: false },
    ],
  },
  {
    title: 'GlobalTranz: Arlington, TX to Dallas, TX', broker: 'GlobalTranz', id: '#8965615', value: '$1,240.00', age: '2 days old', verdict: 'pending',
    vrows: [
      { label: 'Rate confirmation', status: 'Present', ok: true },
      { label: 'POD uploaded', status: 'Present', ok: true },
      { label: 'Detention accessorial', status: 'Pending approval', ok: 'warn' },
    ],
  },
];

const VERDICT: Record<Verdict, { bg: string; iconBg: string; color: string; title: string; sub: string; Icon: typeof Check }> = {
  ready:   { bg: '#e6f4ea', iconBg: '#1e8e3e', color: '#1e8e3e', title: 'Ready to release', sub: 'All required paperwork is present', Icon: Check },
  blocked: { bg: '#fce8e6', iconBg: '#d93025', color: '#d93025', title: 'Not ready to release', sub: 'A required POD is still missing', Icon: AlertCircle },
  pending: { bg: '#fef7e0', iconBg: '#f4a000', color: '#b06000', title: 'Hold for accessorial', sub: 'Detention is pending broker approval', Icon: Clock },
};

function Kbd({ label, tone }: { label: string; tone: 'green' | 'amber' | 'gray' }) {
  const c = tone === 'green'
    ? { bg: 'rgba(255,255,255,.22)', border: 'rgba(255,255,255,.34)', color: '#fff' }
    : { bg: '#eef1f4', border: '#dadce0', color: '#5f6368' };
  return (
    <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, minWidth: 20, height: 20, padding: '0 5px', display: 'inline-grid', placeItems: 'center', borderRadius: 5, background: c.bg, border: `1px solid ${c.border}`, color: c.color }}>{label}</span>
  );
}

export default function ReviewQueueCard() {
  const [state, setState] = useState<{ idx: number; results: Result[] }>({ idx: 0, results: [null, null, null] });
  const armed = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const advance = (kind: Exclude<Result, null>) => setState((s) => {
    if (s.idx >= LOADS.length) return s;
    const results = s.results.slice();
    results[s.idx] = kind;
    return { idx: s.idx + 1, results };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!armed.current) return;
      const tag = ((e.target as HTMLElement)?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const s = stateRef.current;
      if (s.idx >= LOADS.length) return;
      const ready = LOADS[s.idx].verdict === 'ready';
      const k = e.key.toLowerCase();
      if (k === 'r') { if (ready) { e.preventDefault(); advance('released'); } }
      else if (k === 'f') { e.preventDefault(); advance('flagged'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); advance('skipped'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const { idx, results } = state;
  const done = idx >= LOADS.length;

  return (
    <div
      onMouseEnter={() => { armed.current = true; }}
      onMouseLeave={() => { armed.current = false; }}
      style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 18px 44px -18px rgba(26,35,50,.30)', overflow: 'hidden' }}
    >
      {done ? (
        <div style={{ padding: '42px 26px', textAlign: 'center' }}>
          <div style={{ width: 54, height: 54, borderRadius: 999, background: '#e6f4ea', color: '#1e8e3e', display: 'grid', placeItems: 'center', margin: '0 auto' }}>
            <Check size={24} strokeWidth={2.6} />
          </div>
          <div className="font-display" style={{ fontWeight: 800, fontSize: 22, color: '#202124', marginTop: 14 }}>Queue clear</div>
          <div style={{ fontSize: 13.5, color: '#5f6368', marginTop: 5 }}>{results.filter(Boolean).length} loads reviewed this pass</div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginTop: 20 }}>
            <div><div className="font-display" style={{ fontWeight: 800, fontSize: 19, color: '#1e8e3e' }}>{results.filter((r) => r === 'released').length}</div><div style={{ fontSize: 11.5, color: '#5f6368' }}>released</div></div>
            <div><div className="font-display" style={{ fontWeight: 800, fontSize: 19, color: '#b06000' }}>{results.filter((r) => r === 'flagged').length}</div><div style={{ fontSize: 11.5, color: '#5f6368' }}>flagged</div></div>
            <div><div className="font-display" style={{ fontWeight: 800, fontSize: 19, color: '#5f6368' }}>{results.filter((r) => r === 'skipped').length}</div><div style={{ fontSize: 11.5, color: '#5f6368' }}>skipped</div></div>
          </div>
          <button type="button" onClick={() => setState({ idx: 0, results: [null, null, null] })} className="font-display" style={{ marginTop: 22, display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 14, color: '#1967d2', background: '#e8f0fe', border: 'none', borderRadius: 999, padding: '11px 20px', cursor: 'pointer' }}>
            <RotateCcw size={14} strokeWidth={2.4} /> Run the demo again
          </button>
        </div>
      ) : (() => {
        const load = LOADS[idx];
        const vd = VERDICT[load.verdict];
        const ready = load.verdict === 'ready';
        return (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: '1px solid #e8eaed', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{load.title}</div>
                <div style={{ fontSize: 12.5, color: '#5f6368', marginTop: 2 }}>{load.broker} · {load.id} · {load.value}</div>
              </div>
              <div style={{ textAlign: 'right', flex: 'none' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#b06000', background: '#fef7e0', padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap' }}>{load.age}</div>
                <div className="font-mono" style={{ fontSize: 11, color: '#9aa0a6', marginTop: 5 }}>Load {idx + 1} of {LOADS.length}</div>
              </div>
            </div>

            <div style={{ margin: '16px 20px 0', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 13, background: vd.bg }}>
              <span style={{ width: 34, height: 34, flex: 'none', borderRadius: 999, display: 'grid', placeItems: 'center', background: vd.iconBg, color: '#fff' }}>
                <vd.Icon size={17} strokeWidth={2.6} />
              </span>
              <div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: vd.color }}>{vd.title}</div>
                <div style={{ fontSize: 12.5, color: '#5f6368', marginTop: 1 }}>{vd.sub}</div>
              </div>
            </div>

            <div style={{ padding: '16px 20px 6px' }}>
              <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 6 }}>Verification</div>
              {load.vrows.map((v) => {
                const tone = v.ok === true ? { Icon: Check, iconBg: '#e6f4ea', iconColor: '#1e8e3e', statusColor: '#1e8e3e' }
                  : v.ok === 'warn' ? { Icon: Clock, iconBg: '#fef7e0', iconColor: '#b06000', statusColor: '#b06000' }
                  : { Icon: X, iconBg: '#fce8e6', iconColor: '#d93025', statusColor: '#d93025' };
                return (
                  <div key={v.label} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderTop: '1px solid #f1f3f4' }}>
                    <span style={{ width: 22, height: 22, flex: 'none', borderRadius: 999, display: 'grid', placeItems: 'center', background: tone.iconBg, color: tone.iconColor }}>
                      <tone.Icon size={12} strokeWidth={2.8} />
                    </span>
                    <span style={{ flex: 1, fontSize: 14, color: '#3c4043' }}>{v.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: tone.statusColor }}>{v.status}</span>
                  </div>
                );
              })}
            </div>

            <div style={{ padding: '14px 20px 18px', borderTop: '1px solid #e8eaed', marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => ready && advance('released')} disabled={!ready} className="font-display" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9, fontWeight: 600, fontSize: 14, border: 'none', borderRadius: 10, padding: '13px 16px', cursor: ready ? 'pointer' : 'default', background: ready ? '#1e8e3e' : '#eef1f4', color: ready ? '#fff' : '#9aa0a6' }}>
                <Check size={15} strokeWidth={2.6} /> Release for invoicing <Kbd label="R" tone={ready ? 'green' : 'gray'} />
              </button>
              <button type="button" onClick={() => advance('flagged')} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14, border: '1px solid #f4c430', borderRadius: 10, padding: '13px 15px', cursor: 'pointer', background: '#fef7e0', color: '#b06000' }}>
                <Flag size={14} strokeWidth={2.4} /> Flag <Kbd label="F" tone="amber" />
              </button>
              <button type="button" onClick={() => advance('skipped')} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14, border: '1px solid #dadce0', borderRadius: 10, padding: '13px 15px', cursor: 'pointer', background: '#fff', color: '#5f6368' }}>
                Skip <Kbd label="→" tone="gray" />
              </button>
            </div>
          </>
        );
      })()}
    </div>
  );
}
