'use client';

/**
 * FlagModal — the "Flag for follow-up" panel for /product/paperwork (Section
 * B, left). Pick one reason; selecting it highlights the option and enables
 * the amber "Flag load" button. Illustrative — no data, no submit.
 */
import { useState } from 'react';
import { Flag, X } from 'lucide-react';

const REASONS: ReadonlyArray<{ key: string; title: string; desc: string }> = [
  { key: 'missing_pod', title: 'Missing POD',      desc: "Driver hasn't uploaded the signed POD yet." },
  { key: 'awaiting_rc', title: 'Awaiting rate con', desc: "Customer hasn't sent the updated rate con." },
  { key: 'detention',   title: 'Detention pending', desc: 'Detention slip not collected or not approved.' },
  { key: 'lumper',      title: 'Lumper pending',    desc: 'Lumper receipt not yet collected.' },
  { key: 'rate',        title: 'Rate mismatch',     desc: "Rate con and load price don't agree." },
  { key: 'other',       title: 'Other',             desc: 'Anything else; describe it in the note.' },
];

export default function FlagModal() {
  const [reason, setReason] = useState<string | null>(null);
  const hasReason = reason !== null;

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 18px 44px -18px rgba(26,35,50,.30)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '18px 20px 16px' }}>
        <span style={{ width: 36, height: 36, flex: 'none', borderRadius: 9, background: '#fef7e0', color: '#b06000', display: 'grid', placeItems: 'center' }}>
          <Flag size={17} strokeWidth={2.4} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 16, color: '#202124' }}>Flag for follow-up</div>
          <div style={{ fontSize: 12, color: '#5f6368', marginTop: 2 }}>TQL: Fort Worth, TX → Garland, TX · #8649331</div>
        </div>
        <button type="button" onClick={() => setReason(null)} aria-label="Close" style={{ color: '#9aa0a6', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center' }}>
          <X size={18} strokeWidth={2.2} />
        </button>
      </div>

      <div style={{ padding: '0 20px' }}>
        <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 9 }}>Reason</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {REASONS.map((r) => {
            const active = reason === r.key;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => setReason(r.key)}
                style={{ textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '11px 13px', transition: 'all .15s', background: active ? '#e8f0fe' : '#fff', border: `1px solid ${active ? '#1a73e8' : '#e8eaed'}` }}
              >
                <div className="font-display" style={{ fontWeight: 600, fontSize: 14, color: '#202124' }}>{r.title}</div>
                <div style={{ fontSize: 12, color: '#5f6368', marginTop: 2 }}>{r.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '16px 20px 4px' }}>
        <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 8 }}>Note</div>
        <div style={{ border: '1px solid #dadce0', borderRadius: 10, padding: '11px 13px', fontSize: 13, color: '#9aa0a6', minHeight: 54 }}>What you&rsquo;re waiting on, who to call, customer dispute details…</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '14px 20px 18px' }}>
        <button type="button" onClick={() => setReason(null)} className="font-display" style={{ fontWeight: 600, fontSize: 14, color: '#5f6368', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
        <button type="button" disabled={!hasReason} className="font-display" style={{ fontWeight: 600, fontSize: 14, border: 'none', borderRadius: 10, padding: '11px 20px', cursor: hasReason ? 'pointer' : 'default', background: hasReason ? '#b06000' : '#f1f3f4', color: hasReason ? '#fff' : '#9aa0a6' }}>Flag load</button>
      </div>
    </div>
  );
}
