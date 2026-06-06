'use client';

import { useState } from 'react';
import { X, Flag } from 'lucide-react';

export type FlagReason =
  | 'missing_pod'
  | 'awaiting_rate_con'
  | 'detention_pending'
  | 'lumper_pending'
  | 'rate_mismatch'
  | 'other';

const REASONS: { value: FlagReason; label: string; hint: string }[] = [
  { value: 'missing_pod',       label: 'Missing POD',          hint: 'Driver hasn\'t uploaded the signed POD yet.' },
  { value: 'awaiting_rate_con', label: 'Awaiting rate con',    hint: 'Customer hasn\'t sent the updated rate con (lumper/detention add).' },
  { value: 'detention_pending', label: 'Detention pending',    hint: 'Detention slip not yet collected or invoice not approved.' },
  { value: 'lumper_pending',    label: 'Lumper pending',       hint: 'Lumper receipt not yet collected.' },
  { value: 'rate_mismatch',     label: 'Rate mismatch',        hint: 'Rate con and load price don\'t agree — needs review.' },
  { value: 'other',             label: 'Other',                hint: 'Anything else; describe it in the note.' },
];

export interface FlagModalProps {
  loadLabel: string;
  onCancel: () => void;
  onConfirm: (reason: FlagReason, note: string) => Promise<void> | void;
}

export function FlagModal({ loadLabel, onCancel, onConfirm }: FlagModalProps) {
  const [reason, setReason] = useState<FlagReason | null>(null);
  const [note,   setNote]   = useState('');
  const [busy,   setBusy]   = useState(false);

  const canSubmit = reason !== null && !busy;

  async function submit() {
    if (!reason || busy) return;
    setBusy(true);
    try {
      await onConfirm(reason, note);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="rounded-2xl flex flex-col"
        style={{
          background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)',
          width: 520, maxHeight: '85vh', border: '1px solid var(--gc-border-light)',
        }}>
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-start gap-3">
            <div style={{ background: '#fef3c7', borderRadius: 10, padding: 8, flexShrink: 0 }}>
              <Flag size={18} style={{ color: '#92400e' }} />
            </div>
            <div>
              <div className="text-base font-semibold mb-0.5" style={{ color: 'var(--gc-text-1)' }}>
                Flag for follow-up
              </div>
              <div className="text-xs" style={{ color: 'var(--gc-text-2)' }}>
                {loadLabel}
              </div>
            </div>
          </div>
          <button onClick={() => !busy && onCancel()}
            className="p-1 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Reasons + note */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5"
            style={{ color: 'var(--gc-text-3)' }}>
            Reason
          </div>
          <div className="space-y-1.5">
            {REASONS.map(r => {
              const active = reason === r.value;
              return (
                <button key={r.value} type="button"
                  onClick={() => setReason(r.value)}
                  className="w-full text-left rounded-lg transition-colors"
                  style={{
                    border: `1px solid ${active ? '#92400e' : 'var(--gc-border)'}`,
                    background: active ? '#fef3c7' : 'transparent',
                    padding: '9px 12px',
                  }}>
                  <div className="text-sm font-semibold" style={{ color: active ? '#78350f' : 'var(--gc-text-1)' }}>
                    {r.label}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: active ? '#92400e' : 'var(--gc-text-3)' }}>
                    {r.hint}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="pt-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5"
              style={{ color: 'var(--gc-text-3)' }}>
              Note
            </div>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="What we're waiting on, who to call, customer dispute details, etc."
              rows={3}
              className="w-full rounded-lg outline-none text-sm"
              style={{
                border: '1px solid var(--gc-border)', padding: '8px 10px',
                color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
                resize: 'vertical', lineHeight: '1.5', fontFamily: 'inherit',
              }} />
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-6 py-3"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <button onClick={() => !busy && onCancel()}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: 'var(--gc-text-2)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            disabled={busy}>
            Cancel
          </button>
          <button onClick={submit}
            disabled={!canSubmit}
            className="px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{
              background: canSubmit ? '#d97706' : 'var(--gc-border)',
              color: '#fff',
              cursor: canSubmit ? 'pointer' : 'default',
            }}>
            {busy ? 'Flagging…' : 'Flag load'}
          </button>
        </div>
      </div>
    </div>
  );
}
