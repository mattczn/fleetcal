'use client';

/**
 * SendIntroButton — one-click "send the intro email" for a lead. Fires
 * POST /crm/leads/:id/send-intro, which renders the crm_settings intro
 * template and sends it immediately (not queued). Shows sending / sent /
 * retry inline. Renders nothing when the lead has no email on file.
 *
 * Used standalone on the lead drawer (the carrier page) and inside the
 * LogCallControl popover (so the list + outbox get it too, right after a
 * call). Stops click propagation so it never opens the row it sits in.
 */

import { useState } from 'react';
import { Send, Loader2, Check } from 'lucide-react';
import { railway } from '@/lib/railway';

export default function SendIntroButton({
  leadId,
  email,
  compact = false,
}: {
  leadId: string;
  email?: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  if (!email) return null;

  async function send() {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try {
      await railway.crmSendIntro(leadId);
      setState('sent');
    } catch {
      setState('error');
    }
  }

  const label =
    state === 'sending' ? 'Sending…' :
    state === 'sent'    ? 'Intro sent' :
    state === 'error'   ? 'Retry intro' :
                          'Send intro email';
  const Icon = state === 'sending' ? Loader2 : state === 'sent' ? Check : Send;

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void send(); }}
      disabled={state === 'sending'}
      title={state === 'error' ? 'Send failed, click to retry' : `Send the intro email to ${email}`}
      className="inline-flex items-center gap-1.5 rounded-lg font-semibold transition-colors disabled:opacity-70"
      style={{
        fontSize: compact ? 11 : 12,
        padding: compact ? '4px 9px' : '6px 12px',
        background: state === 'sent' ? '#e6f4ea' : '#1a73e8',
        color: state === 'sent' ? '#188038' : '#fff',
        border: state === 'error' ? '1px solid #c5221f' : '1px solid transparent',
      }}
    >
      <Icon size={compact ? 11 : 12} className={state === 'sending' ? 'animate-spin' : undefined} />
      {label}
    </button>
  );
}
