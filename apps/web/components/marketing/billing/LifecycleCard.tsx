'use client';

/**
 * LifecycleCard — the "Track to paid" island for /product/billing. Advances
 * one invoice through released → queued → invoiced → paid; the timeline,
 * status pill, and action buttons update per stage. Illustrative — no data.
 */
import { useState } from 'react';
import { Check, FileText, Send, RotateCcw } from 'lucide-react';

type Status = 'released' | 'queued' | 'invoiced' | 'paid';
const ORDER: Status[] = ['released', 'queued', 'invoiced', 'paid'];
const STATUS_MAP: Record<Status, { label: string; color: string; bg: string }> = {
  released: { label: 'Released', color: '#1a73e8', bg: '#e8f0fe' },
  queued:   { label: 'Queued',   color: '#6941c6', bg: '#f3e8fd' },
  invoiced: { label: 'Invoiced', color: '#0e9d9d', bg: '#defafa' },
  paid:     { label: 'Paid',     color: '#1e8e3e', bg: '#e6f4ea' },
};
const TIMELINE: ReadonlyArray<{ label: string; done: string; pending: string }> = [
  { label: 'Released for billing', done: 'Verified in Paperwork', pending: 'Ready to invoice' },
  { label: 'Invoice generated',    done: 'Documents attached',    pending: 'Builds the PDF' },
  { label: 'Sent to Arrive AP',    done: 'invoicing@arrive.com',  pending: 'Emails the customer' },
  { label: 'Payment received',     done: 'Net 30 · paid in full', pending: 'Awaiting payment' },
];

export default function LifecycleCard() {
  const [status, setStatus] = useState<Status>('released');
  const sIdx = ORDER.indexOf(status);
  const sm = STATUS_MAP[status];

  let primaryLabel: string, primaryIcon: React.ReactNode, primaryAction: () => void;
  let primaryBg = '#1a73e8', primaryColor = '#fff', primaryCursor = 'pointer';
  let secondary: { label: string; icon: React.ReactNode } | null = null;
  if (status === 'released') {
    primaryLabel = 'Generate invoice'; primaryIcon = <FileText size={15} strokeWidth={2.2} />; primaryAction = () => setStatus('queued');
  } else if (status === 'queued') {
    primaryLabel = 'Create & send'; primaryIcon = <Send size={15} strokeWidth={2.2} />; primaryAction = () => setStatus('invoiced');
    secondary = { label: 'Regenerate', icon: <RotateCcw size={14} strokeWidth={2.3} /> };
  } else if (status === 'invoiced') {
    primaryLabel = 'Mark paid'; primaryIcon = <Check size={15} strokeWidth={2.6} />; primaryBg = '#1e8e3e'; primaryAction = () => setStatus('paid');
    secondary = { label: 'Resend invoice', icon: <Send size={14} strokeWidth={2.2} /> };
  } else {
    primaryLabel = 'Paid in full'; primaryIcon = <Check size={15} strokeWidth={2.6} />; primaryBg = '#e6f4ea'; primaryColor = '#1e8e3e'; primaryCursor = 'default'; primaryAction = () => {};
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e8eaed', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#1967d2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Arrive: Fort Worth, TX → Lancaster, TX</div>
          <div style={{ fontSize: 12, color: '#5f6368', marginTop: 2 }}>#1494245 · $535.00</div>
        </div>
        <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flex: 'none', fontWeight: 600, fontSize: 12.5, padding: '6px 12px', borderRadius: 999, background: sm.bg, color: sm.color }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: sm.color }} />{sm.label}
        </span>
      </div>

      <div style={{ padding: '18px 20px 6px' }}>
        {TIMELINE.map((t, i) => {
          const done = i <= sIdx;
          const current = i === sIdx;
          const c = STATUS_MAP[ORDER[i]].color;
          return (
            <div key={t.label} style={{ display: 'flex', gap: 13 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ width: 22, height: 22, flex: 'none', borderRadius: 999, background: done ? c : '#fff', border: `2px solid ${done ? c : '#dadce0'}`, display: 'grid', placeItems: 'center', color: '#fff' }}>{done && <Check size={11} strokeWidth={3} />}</span>
                {i < TIMELINE.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 18, background: i < sIdx ? c : '#eef1f4' }} />}
              </div>
              <div style={{ paddingBottom: 14 }}>
                <div className="font-display" style={{ fontWeight: 600, fontSize: 14, color: done ? '#202124' : '#9aa0a6' }}>{t.label}</div>
                <div style={{ fontSize: 12, color: current ? c : '#9aa0a6', marginTop: 1 }}>{done ? t.done : t.pending}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px 18px', borderTop: '1px solid #e8eaed', marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={primaryAction} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 600, fontSize: 14, border: 'none', borderRadius: 10, padding: '12px 18px', cursor: primaryCursor, background: primaryBg, color: primaryColor }}>
          {primaryIcon} {primaryLabel}
        </button>
        {secondary && (
          <button type="button" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13.5, border: '1px solid #dadce0', borderRadius: 10, padding: '12px 15px', cursor: 'pointer', background: '#fff', color: '#5f6368' }}>
            {secondary.icon} {secondary.label}
          </button>
        )}
        {status === 'paid' && (
          <button type="button" onClick={() => setStatus('released')} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13.5, border: 'none', borderRadius: 10, padding: '12px 15px', cursor: 'pointer', background: '#e8f0fe', color: '#1967d2' }}>
            <RotateCcw size={14} strokeWidth={2.3} /> Run again
          </button>
        )}
      </div>
    </div>
  );
}
