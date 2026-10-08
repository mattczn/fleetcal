'use client';

/**
 * InvoiceDeliveryHistory — when each invoice on this load actually went out,
 * and to whom.
 *
 * The load history already said "Billing status changed from verified to
 * invoiced". That records a state change in FleetCal; it does not answer the
 * question someone actually has months later, which is "did this reach the
 * broker, when, and at what address". Those are different facts and only the
 * second one settles an argument with an AP desk.
 *
 * The data has been there all along — sent_at / sent_to / sent_method on
 * 5,509 invoices back to 2025-12-29 — it was simply never shown anywhere.
 *
 * Rendered as its own block rather than merged into the audit timeline on
 * purpose. Audit entries carry an actor ("by Matt"), and invoices record no
 * one: sent_at has no companion sent_by column. Folding these into the same
 * list would mean inventing an author or printing "by Unknown", and a
 * history that invents attribution is worse than one that stays quiet about
 * it.
 */

import type { Invoice } from '@fleetcal/types';

export interface InvoiceDeliveryHistoryProps {
  invoices: Invoice[];
  timeZone?: string;
}

const METHOD_LABEL: Record<string, string> = {
  email:  'by email',
  portal: 'through the broker portal',
  manual: 'marked sent by hand',
};

function fmt(iso: string, timeZone?: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short', day: '2-digit', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

export default function InvoiceDeliveryHistory({ invoices, timeZone }: InvoiceDeliveryHistoryProps) {
  // Only invoices that actually went out. A draft has nothing to report, and
  // a row saying "not sent" would be noise on every load mid-cycle.
  const sent = invoices
    .filter(i => i.sentAt)
    .sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));

  if (sent.length === 0) return null;

  return (
    <>
      {sent.map(inv => {
        // 'manual' means someone recorded that it was sent, not that we sent
        // it — so there is no recipient to show and claiming one would be a
        // guess. Say what is known and stop there.
        const method = inv.sentMethod ?? 'manual';
        const showTo = method !== 'manual' && !!inv.sentTo;
        return (
          <div key={inv.id}
               style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase',
              padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap',
              background: '#e8f0fe', color: '#1558d6',
            }}>
              Invoice
            </span>
            <span style={{ color: 'var(--gc-text-1)' }}>
              <strong>#{inv.invoiceNumber}</strong> sent{' '}
              {showTo ? (
                <>to <strong style={{ wordBreak: 'break-all' }}>{inv.sentTo}</strong> </>
              ) : null}
              {METHOD_LABEL[method] ?? method}
            </span>
            <span style={{ color: 'var(--gc-text-3)', whiteSpace: 'nowrap' }}>
              · {fmt(String(inv.sentAt), timeZone)}
            </span>
          </div>
        );
      })}
    </>
  );
}
