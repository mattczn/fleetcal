'use client';

/**
 * /accounting/invoices/[id] — single-invoice page route.
 *
 * Thin wrapper around <InvoiceDetailView> in page mode. The same view
 * powers Closeout's in-context modal; this route is just here for
 * deep-linking + the Generate-and-send (?send=1) flow.
 */

import { useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { InvoiceDetailView } from '@/components/invoicing/InvoiceDetailView';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const id = params?.id as string;

  // ?send=1 came from the closeout "Generate & send" path — the view
  // auto-opens the email dialog on mount and we strip the param so a
  // refresh doesn't re-pop the dialog.
  const autoOpenEmail = search?.get('send') === '1';

  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);

  return (
    <>
      <InvoiceDetailView
        invoiceId={id}
        mode="page"
        onClose={() => router.back()}
        autoOpenEmail={autoOpenEmail}
        onBrokerClick={(brokerId) => setBrokerProfileId(brokerId)}
      />
      {brokerProfileId && (
        <BrokerProfileModal
          initialBrokerId={brokerProfileId}
          onClose={() => setBrokerProfileId(null)}
        />
      )}
    </>
  );
}
