'use client';

/**
 * ConfirmDialog — small yes/no modal to replace window.confirm.
 *
 * Pass a `zIndex` higher than the layer the dialog is opening from
 * (review queue is z-180, EventModal is z-200). Default 260 sits above
 * everything in the app.
 *
 * `destructive` swaps the confirm button to red (the standard delete
 * surface) so users get a visual cue that this isn't undoable.
 */

import { AlertCircle } from 'lucide-react';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  zIndex?: number;
}

export default function ConfirmDialog({
  title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  destructive, onConfirm, onCancel, zIndex = 260,
}: Props) {
  return (
    <div className="fixed inset-0 flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.5)', zIndex }}
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="rounded-2xl flex flex-col w-full"
        style={{
          maxWidth:   420,
          background: 'var(--gc-surface)',
          boxShadow:  '0 16px 48px rgba(0,0,0,0.25)',
          border:     '1px solid var(--gc-border)',
        }}>
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          {destructive && (
            <div className="flex items-center justify-center flex-shrink-0 rounded-full"
              style={{ width: 36, height: 36, background: '#fce8e6', color: '#d93025' }}>
              <AlertCircle size={18} />
            </div>
          )}
          <div className="flex-1">
            <div className="text-[16px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
              {title}
            </div>
            <div className="text-[13px] font-medium mt-1" style={{ color: 'var(--gc-text-2)' }}>
              {message}
            </div>
          </div>
        </div>
        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <button type="button" onClick={onCancel}
            className="text-[13px] font-bold px-4 py-2 rounded-lg transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm}
            autoFocus
            className="text-[13px] font-extrabold px-4 py-2 rounded-lg transition-colors text-white"
            style={{ background: destructive ? '#d93025' : 'var(--gc-blue)' }}
            onMouseEnter={e => (e.currentTarget.style.background = destructive ? '#b1271b' : 'var(--gc-blue-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = destructive ? '#d93025' : 'var(--gc-blue)')}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
