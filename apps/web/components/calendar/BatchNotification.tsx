'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function BatchNotification() {
  const {
    batchParseProgress, batchParseTotal, batchMinimized,
    batchItems, setBatchMinimized, requestBatchCancel,
  } = useCalendarStore();

  const [confirmCancel, setConfirmCancel] = useState(false);

  const isParsing = batchParseTotal > 0;

  // Warn on browser close / refresh while data is pending
  useEffect(() => {
    if (!isParsing && batchItems.length === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isParsing, batchItems.length]);

  // Reset confirm state when overlay is hidden
  useEffect(() => {
    if (!isParsing || batchMinimized) setConfirmCancel(false);
  }, [isParsing, batchMinimized]);

  // Only show full-screen overlay while parsing and not minimized
  if (!isParsing || batchMinimized) return null;

  const current = Math.min(batchParseProgress + 1, batchParseTotal);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
    >
      <div
        className="flex flex-col items-center gap-6 rounded-2xl"
        style={{
          background: 'var(--gc-surface)',
          boxShadow: 'var(--shadow-3)',
          padding: '48px 56px',
          minWidth: 360,
        }}
      >
        <Loader2 size={36} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />

        <div className="flex flex-col items-center gap-1.5 text-center">
          <div className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            Processing rate con {current} of {batchParseTotal}
          </div>
          <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
            AI is extracting load details…
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: batchParseTotal }, (_, i) => (
            <div
              key={i}
              className="rounded-full transition-all"
              style={{
                width:      i < batchParseProgress ? 8 : i === batchParseProgress ? 10 : 6,
                height:     i < batchParseProgress ? 8 : i === batchParseProgress ? 10 : 6,
                background: i < batchParseProgress
                  ? '#16a34a'
                  : i === batchParseProgress
                    ? 'var(--gc-blue)'
                    : 'var(--gc-border)',
              }}
            />
          ))}
        </div>

        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => setBatchMinimized(true)}
            className="px-5 py-2.5 rounded-full text-sm font-medium transition-colors"
            style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            Keep Working
          </button>

          {confirmCancel ? (
            <div className="flex flex-col items-center gap-2">
              <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>Cancel import?</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setConfirmCancel(false); requestBatchCancel(); }}
                  className="px-4 py-2 rounded-full text-sm font-medium transition-colors"
                  style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#fef2f2')}
                >
                  Yes, cancel
                </button>
                <button
                  onClick={() => setConfirmCancel(false)}
                  className="px-4 py-2 rounded-full text-sm font-medium transition-colors"
                  style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  Keep going
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmCancel(true)}
              className="px-4 py-2 rounded-full text-sm font-medium transition-colors"
              style={{ color: '#dc2626', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#fef2f2')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
