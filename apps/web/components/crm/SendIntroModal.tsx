'use client';

/**
 * SendIntroModal — the review/edit step before an intro email goes out.
 * Opens from SendIntroButton, loads the rendered template (POST
 * send-intro {preview:true}), lets the operator tweak the subject + body
 * to fit the conversation, then sends the edited text. Nothing goes out
 * on a single click — this is the deliberate verifier.
 *
 * Fixed full-screen overlay (z-60) so it clears the leads table's
 * overflow clip and the lead drawer. Backdrop click / Cancel closes.
 */

import { useState, useEffect } from 'react';
import { X, Send, Loader2, Check } from 'lucide-react';
import { railway, RailwayError } from '@/lib/railway';

export default function SendIntroModal({
  leadId,
  email,
  onClose,
  onSent,
}: {
  leadId: string;
  email: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    railway.crmIntroPreview(leadId)
      .then((res) => { if (!cancelled) { setSubject(res.subject); setBody(res.body); } })
      .catch(() => { if (!cancelled) setError('Could not load the intro template.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [leadId]);

  async function send() {
    if (!subject.trim() || !body.trim()) { setError('Subject and body are required.'); return; }
    setSending(true);
    setError(null);
    try {
      await railway.crmSendIntro(leadId, { subject: subject.trim(), body });
      setSent(true);
      window.setTimeout(onSent, 800);
    } catch (e) {
      const d = e instanceof RailwayError && e.detail && typeof e.detail === 'object'
        ? (e.detail as { detail?: string; errors?: string[] })
        : null;
      setError(d?.detail ?? d?.errors?.[0] ?? 'Send failed.');
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl w-full max-w-2xl flex flex-col overflow-hidden"
        style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-3)', maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="min-w-0">
            <div className="text-[14px] font-bold" style={{ color: 'var(--gc-text-1)' }}>Review intro email</div>
            <div className="text-[12px] truncate" style={{ color: 'var(--gc-text-3)' }}>To: {email}</div>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--gc-hover)]" style={{ color: 'var(--gc-text-2)' }}>
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-3">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full mt-1 rounded-lg px-3 py-2 text-[13.5px] outline-none"
                style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Body</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={14}
                className="w-full mt-1 rounded-lg px-3 py-2 text-[13px] leading-[1.55] outline-none resize-y"
                style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}
              />
              <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                Your signature, website line, and CAN-SPAM/unsubscribe footer are appended automatically on send.
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 px-5 py-3.5" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <span className="text-[12px] font-semibold truncate" style={{ color: error ? '#c5221f' : 'var(--gc-text-3)' }}>
            {error ?? (sent ? 'Sent.' : '')}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={onClose} disabled={sending}
              className="text-[13px] font-semibold px-3.5 py-2 rounded-lg disabled:opacity-50" style={{ color: 'var(--gc-text-2)' }}>
              Cancel
            </button>
            <button type="button" onClick={() => void send()} disabled={loading || sending || sent}
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-4 py-2 rounded-lg transition-opacity disabled:opacity-60"
              style={{ background: sent ? '#188038' : '#1a73e8', color: '#fff' }}>
              {sending ? <Loader2 size={13} className="animate-spin" /> : sent ? <Check size={13} /> : <Send size={13} />}
              {sent ? 'Sent' : sending ? 'Sending…' : 'Send email'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
