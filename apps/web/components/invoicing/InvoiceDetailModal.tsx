'use client';

/**
 * InvoiceDetailModal — frames InvoiceDetailView as a centered popup.
 *
 * Used by Closeout's "View invoice" button (and anywhere else we want
 * to inspect an invoice without navigating away from the parent
 * screen). For deep-linking / Generate-and-send the full-page route
 * /accounting/invoices/[id] still exists; the modal is just a quieter
 * surface for in-context review.
 */

import { useEffect, useState } from 'react';
import { InvoiceDetailView } from './InvoiceDetailView';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';

interface Props {
  invoiceId: string;
  onClose:   () => void;
}

export function InvoiceDetailModal({ invoiceId, onClose }: Props) {
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);

  // Close on Escape (when the broker profile modal isn't open — let
  // that handle its own dismissal).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !brokerProfileId) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, brokerProfileId]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden"
        style={{
          width: 'min(1280px, 96vw)',
          height: 'min(900px, 92vh)',
          background: 'var(--gc-bg)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.32)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}>
        <InvoiceDetailView
          invoiceId={invoiceId}
          mode="modal"
          onClose={onClose}
          onBrokerClick={(id) => setBrokerProfileId(id)}
        />
      </div>

      {brokerProfileId && (
        <BrokerProfileModal
          initialBrokerId={brokerProfileId}
          onClose={() => setBrokerProfileId(null)}
        />
      )}
    </div>
  );
}
