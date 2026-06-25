'use client';

/**
 * RoutingCard — the "AI invoice routing" island for /product/billing.
 * "Extract from rate con" stands in for the AI parse: it flips on the
 * confirmation banner and forces Email. The segmented Email/Portal toggle
 * swaps the destination field. Illustrative — no data, no persistence.
 */
import { useState } from 'react';
import { Sparkles, Mail, Link2 } from 'lucide-react';

export default function RoutingCard() {
  const [method, setMethod] = useState<'email' | 'portal'>('email');
  const [refreshed, setRefreshed] = useState(false);
  const isEmail = method === 'email';

  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e8eaed' }}>
        <span className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5f6368' }}>Invoice routing</span>
        <button type="button" onClick={() => { setRefreshed(true); setMethod('email'); }} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12, letterSpacing: '.04em', textTransform: 'uppercase', color: '#6941c6', background: '#f3e8fd', border: 'none', borderRadius: 8, padding: '8px 12px', cursor: 'pointer' }}>
          <Sparkles size={13} strokeWidth={2.4} /> Extract from rate con
        </button>
      </div>
      <div style={{ padding: 20 }}>
        {refreshed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#f3e8fd', border: '1px solid #e9d5ff', borderRadius: 10, padding: '10px 13px', marginBottom: 16 }}>
            <span style={{ width: 22, height: 22, flex: 'none', borderRadius: 999, background: '#6941c6', color: '#fff', display: 'grid', placeItems: 'center' }}><Sparkles size={12} strokeWidth={2.6} /></span>
            <span style={{ fontSize: 13, color: '#3c4043' }}>Rate con says <strong style={{ color: '#202124' }}>email AP</strong>. Method set to <strong style={{ color: '#1967d2' }}>Email</strong>.</span>
          </div>
        )}
        <div style={{ display: 'inline-flex', background: '#eef1f4', borderRadius: 9, padding: 3, marginBottom: 18 }}>
          <button type="button" onClick={() => setMethod('email')} className="font-display" style={{ fontWeight: 600, fontSize: 13.5, padding: '8px 18px', borderRadius: 7, border: 'none', cursor: 'pointer', background: isEmail ? '#fff' : 'transparent', color: isEmail ? '#1967d2' : '#5f6368' }}>Email</button>
          <button type="button" onClick={() => setMethod('portal')} className="font-display" style={{ fontWeight: 600, fontSize: 13.5, padding: '8px 18px', borderRadius: 7, border: 'none', cursor: 'pointer', background: !isEmail ? '#fff' : 'transparent', color: !isEmail ? '#1967d2' : '#5f6368' }}>Online portal</button>
        </div>
        <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 7 }}>{isEmail ? 'Billing email' : 'Portal link'}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #dadce0', borderRadius: 10, padding: '12px 14px' }}>
          <span style={{ color: '#9aa0a6', display: 'grid', placeItems: 'center' }}>{isEmail ? <Mail size={15} /> : <Link2 size={15} />}</span>
          <span style={{ fontSize: 14, color: '#202124' }}>{isEmail ? 'ap@arrivelogistics.com' : 'portal.arrivelogistics.com/ap'}</span>
        </div>
        <div style={{ fontSize: 12, color: '#9aa0a6', marginTop: 10 }}>Shown on every invoice for this customer in the &ldquo;Bill To&rdquo; block.</div>
        <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368', margin: '18px 0 7px' }}>Invoicing instructions</div>
        <div style={{ border: '1px solid #dadce0', borderRadius: 10, padding: '11px 13px', fontSize: 13, lineHeight: 1.55, color: '#3c4043' }}>
          Submit POD within 48 hours of delivery. For payment inquiries contact <span style={{ color: '#1967d2', fontWeight: 600 }}>apquestions@arrivelogistics.com</span>.
        </div>
        <div style={{ fontSize: 12, color: '#9aa0a6', marginTop: 8 }}>Relevant instructions pulled from the rate con.</div>
      </div>
    </div>
  );
}
