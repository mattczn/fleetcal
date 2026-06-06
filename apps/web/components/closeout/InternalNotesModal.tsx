'use client';

/**
 * InternalNotesModal — view + append-only note thread for a load.
 *
 * Used from:
 *   - CloseoutView row notes button (z-50, opens over the closeout page)
 *   - ReviewQueue (z-180 review queue → modal needs z-[230] so it
 *     stacks above the queue and above EventModal at z-200)
 *
 * The thread is server-authoritative; saves post via the closeout PATCH
 * action 'append_note', then we drop an optimistic tmp row in so the
 * user doesn't see a jump. Parent triggers a refresh on save to pull
 * the canonical id/timestamp.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import type { InternalNote } from '@fleetcal/types';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

/** Minimal load shape the notes modal actually needs — typed
 *  structurally so both Load (event-shaped) and LoadSummary (load-
 *  shaped) consumers can pass their row in without conversion. */
interface NotesLoad {
  loadId?: string;
  /** Event id — only present on Load. LoadSummary callers pass undefined
   *  and rely on loadId being set (which it always is on LoadSummary). */
  id?: string;
  title?: string;
  loadNum?: string;
  internalNotes?: InternalNote[];
}

interface Props {
  load: NotesLoad;
  actorName?: string;
  onClose: () => void;
  /** Fired after a successful append. Receives the optimistic note
   *  the modal just stitched into its local thread so the parent can
   *  mirror it on its own surfaces (banners, lists) without waiting
   *  for a refetch. Pre-existing callers can continue ignoring the
   *  argument. */
  onSaved: (note?: InternalNote) => Promise<void> | void;
  /** zIndex layer for the modal. Defaults to 50 (covers the page).
   *  Pass a higher value when stacking over the closeout review queue
   *  (z-180) or an open EventModal (z-200) so the notes panel sits on
   *  top. */
  zIndex?: number;
}

export default function InternalNotesModal({
  load, actorName, onClose, onSaved, zIndex = 50,
}: Props) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState(load.internalNotes ?? []);

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const targetId = load.loadId ?? load.id;
      if (!targetId) {
        // Defensive — shouldn't happen since both call sites set one.
        // Without an id we can't PATCH; bail rather than 404 the API.
        setSaving(false);
        return;
      }
      // Suppress the realtime echo of this internal-note append so
      // the dispatcher saving the note doesn't get "updated by
      // another dispatcher" pop on themselves.
      useCalendarStore.getState().markLoadSelfWrite(targetId);
      await railway.updateLoadCloseout(targetId, {
        action:    'append_note',
        noteText:  trimmed,
        actorName,
      });
      const optimistic: InternalNote = {
        id:     'tmp-' + Date.now(),
        text:   trimmed,
        author: actorName ?? null,
        at:     new Date().toISOString(),
      };
      setNotes(prev => [...prev, optimistic]);
      setText('');
      void onSaved(optimistic);
    } finally {
      setSaving(false);
    }
  };

  // Newest at the top.
  const ordered = [...notes].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <div className="fixed inset-0 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.4)', zIndex }}
      onClick={onClose}>
      <div className="rounded-2xl max-w-xl w-full max-h-[80vh] flex flex-col"
        style={{ background: 'var(--gc-surface)', boxShadow: '0 12px 48px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>Internal notes</div>
            <div className="text-[12px] truncate max-w-[420px]" style={{ color: 'var(--gc-text-3)' }}>
              {load.title}{load.loadNum ? ` · #${load.loadNum}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-[var(--gc-hover)]" title="Close">
            <X size={16} />
          </button>
        </div>

        {/* Thread */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {ordered.length === 0 ? (
            <div className="text-[13px] italic py-8 text-center" style={{ color: 'var(--gc-text-3)' }}>
              No notes yet. Add one below.
            </div>
          ) : (
            <ul className="space-y-2.5">
              {ordered.map(n => (
                <li key={n.id} className="rounded-xl px-3 py-2"
                  style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
                  <div className="flex items-baseline justify-between gap-3 mb-0.5">
                    <span className="text-[12px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                      {n.author ?? 'Unknown'}
                    </span>
                    <span className="text-[10px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                      {fmtNoteTimestamp(n.at)}
                    </span>
                  </div>
                  <div className="text-[13px] whitespace-pre-wrap" style={{ color: 'var(--gc-text-1)' }}>
                    {n.text}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Composer */}
        <div className="px-5 py-3" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void handleSave();
              }
            }}
            rows={3}
            placeholder="Add a note for the team…"
            className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none"
            style={{
              background: 'var(--gc-bg)',
              border:     '1px solid var(--gc-border-light)',
              color:      'var(--gc-text-1)',
            }}
          />
          <div className="flex items-center justify-between mt-2">
            <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
              ⌘/Ctrl+Enter to send
            </div>
            <button onClick={handleSave}
              disabled={!text.trim() || saving}
              className="text-[12px] font-semibold px-3.5 py-1.5 rounded-lg transition-opacity"
              style={{
                background: '#1a73e8',
                color:      '#fff',
                opacity:    !text.trim() || saving ? 0.4 : 1,
                cursor:     !text.trim() || saving ? 'not-allowed' : 'pointer',
              }}>
              {saving ? 'Saving…' : 'Add note'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtNoteTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
