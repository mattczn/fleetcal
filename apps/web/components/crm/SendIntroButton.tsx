'use client';

/**
 * SendIntroButton — opens the intro-email review modal for a lead. It no
 * longer sends on click; SendIntroModal loads the rendered template, lets
 * you edit the subject/body to fit the conversation, and sends from there.
 * Renders nothing when the lead has no email on file.
 *
 * Used standalone on the lead drawer (the carrier page) and inside the
 * LogCallControl popover (so the list + outbox get it too, right after a
 * call). Stops click propagation so it never opens the row it sits in.
 */

import { useState } from 'react';
import { Send, Check } from 'lucide-react';
import SendIntroModal from './SendIntroModal';

export default function SendIntroButton({
  leadId,
  email,
  compact = false,
}: {
  leadId: string;
  email?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  if (!email) return null;

  const Icon = sent ? Check : Send;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={`Review and send the intro email to ${email}`}
        className="inline-flex items-center gap-1.5 rounded-lg font-semibold transition-colors"
        style={{
          fontSize: compact ? 11 : 12,
          padding: compact ? '4px 9px' : '6px 12px',
          background: sent ? '#e6f4ea' : '#1a73e8',
          color: sent ? '#188038' : '#fff',
          border: '1px solid transparent',
        }}
      >
        <Icon size={compact ? 11 : 12} />
        {sent ? 'Intro sent' : 'Send intro email'}
      </button>

      {open && (
        <SendIntroModal
          leadId={leadId}
          email={email}
          onClose={() => setOpen(false)}
          onSent={() => { setSent(true); setOpen(false); }}
        />
      )}
    </>
  );
}
