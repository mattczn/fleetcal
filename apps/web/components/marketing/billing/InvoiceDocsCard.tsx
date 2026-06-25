'use client';

/**
 * InvoiceDocsCard — the "Invoice documents" island for /product/billing.
 * Toggle which docs (RC / POD / accessorial receipts) attach to the
 * invoice; the footer count updates live. Illustrative — no data.
 */
import { useState } from 'react';
import { Check, FileText } from 'lucide-react';

type DocKey = 'rc' | 'pod' | 'detention' | 'lumper';
const DOC_DEFS: ReadonlyArray<{ key: DocKey; tag: string; tagColor: string; label: string; meta: string }> = [
  { key: 'rc', tag: 'RC', tagColor: '#6941c6', label: 'Rate confirmation', meta: 'Required' },
  { key: 'pod', tag: 'POD', tagColor: '#1e8e3e', label: 'Proof of delivery', meta: 'Signed' },
  { key: 'detention', tag: 'ACC', tagColor: '#c5631e', label: 'Detention receipt', meta: '$60' },
  { key: 'lumper', tag: 'ACC', tagColor: '#c5631e', label: 'Lumper receipt', meta: 'Optional' },
];

export default function InvoiceDocsCard() {
  const [docs, setDocs] = useState<Record<DocKey, boolean>>({ rc: true, pod: true, detention: true, lumper: false });
  const count = (Object.values(docs) as boolean[]).filter(Boolean).length;

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e8eaed' }}>
        <div>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#1967d2' }}>Arrive: Fort Worth, TX → Lancaster, TX</div>
          <div style={{ fontSize: 12, color: '#5f6368', marginTop: 2 }}>#1494245 · documents on invoice</div>
        </div>
        <span className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124' }}>$535.00</span>
      </div>
      <div style={{ padding: '8px 12px' }}>
        {DOC_DEFS.map((d) => {
          const on = docs[d.key];
          return (
            <button key={d.key} type="button" onClick={() => setDocs((s) => ({ ...s, [d.key]: !s[d.key] }))} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13, padding: '13px 12px', background: 'transparent', border: 'none', borderRadius: 10, cursor: 'pointer' }}>
              <span style={{ width: 22, height: 22, flex: 'none', borderRadius: 6, display: 'grid', placeItems: 'center', background: on ? '#1a73e8' : '#fff', border: `1.5px solid ${on ? '#1a73e8' : '#dadce0'}`, color: '#fff' }}>{on && <Check size={13} strokeWidth={3} />}</span>
              <span className="font-mono" style={{ width: 46, flex: 'none', fontSize: 10, fontWeight: 600, textAlign: 'center', color: '#fff', background: d.tagColor, borderRadius: 5, padding: '3px 0' }}>{d.tag}</span>
              <span style={{ flex: 1, fontSize: 14, color: '#3c4043' }}>{d.label}</span>
              <span style={{ fontSize: 12.5, color: '#9aa0a6' }}>{d.meta}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderTop: '1px solid #e8eaed', background: '#fafbfc' }}>
        <span style={{ fontSize: 13, color: '#5f6368' }}>{count} of 4 documents attached</span>
        <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#1a73e8', color: '#fff', fontWeight: 600, fontSize: 13, padding: '9px 15px', borderRadius: 9 }}><FileText size={14} strokeWidth={2.2} /> Preview invoice</span>
      </div>
    </div>
  );
}
