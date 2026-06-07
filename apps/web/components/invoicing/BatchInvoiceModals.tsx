'use client';

/**
 * Batch-invoice modals — Invoice Summary (generate / generate-and-send)
 * and Batch Send (send draft / resend already-sent).
 *
 * Lifted out of `apps/web/app/accounting/page.tsx` so the load detail
 * page renders the same popups when the dispatcher clicks Generate /
 * Send / Resend from the BillingCard. Any visual or behavioral change
 * here lands in both surfaces — accounting and load detail — without
 * drift.
 */

import { useMemo, useState } from 'react';
import { AlertCircle, FilePlus, Loader2, Receipt, Send, X } from 'lucide-react';
import { railway, RailwayError } from '@/lib/railway';
import { Th, Td, moneyFmt } from '@/components/queue/QueueTablePrimitives';
import type {
  Customer, Invoice,
} from '@fleetcal/types';
import type {
  LoadSummary,
  BatchGenerateInvoicesResponse,
  BatchSendInvoicesResponse,
} from '@fleetcal/types/api';

// ── Invoice Summary Modal ───────────────────────────────────────────────

export interface InvoiceSummaryModalProps {
  loads:        LoadSummary[];
  customerById: Map<string, Customer>;
  action:       'generate' | 'generateSend';
  onOpenBroker: (id: string) => void;
  onClose:      () => void;
  onComplete:   () => void;
}

export function InvoiceSummaryModal({
  loads, customerById, action: initialAction, onOpenBroker, onClose, onComplete,
}: InvoiceSummaryModalProps) {
  const [action, setAction]   = useState<'generate' | 'generateSend'>(initialAction);
  const [bccSelf, setBccSelf] = useState(true);
  const [attachLoadDocs, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchGenerateInvoicesResponse | null>(null);

  // Batch-generate summary uses total_billable (linehaul + accessorials)
  // so the "$X total" in the header matches what the invoices will bill.
  const totalAmount = loads.reduce((s, l) => s + (l.totalBillable ?? l.loadPrice ?? 0), 0);
  const willSend = action === 'generateSend';
  const missingEmail = willSend && loads.some(l => {
    const c = l.customerId ? customerById.get(l.customerId) : undefined;
    return c && (c.invoiceMethod ?? 'email') === 'email' && !c.invoiceEmail;
  });
  const hasPortal = willSend && loads.some(l => {
    const c = l.customerId ? customerById.get(l.customerId) : undefined;
    return c?.invoiceMethod === 'portal';
  });

  async function handleGo() {
    setBusy(true);
    try {
      const loadIds = loads.map(l => l.loadId);
      const res = await railway.batchGenerateInvoices({ loadIds, thenSend: willSend, bccSelf, attachLoadDocs });
      setResult(res);
    } catch (err) {
      console.error('[invoiceSummary] batchGenerate failed:', err);
      const msg = err instanceof RailwayError && err.status === 503
        ? 'Email isn\'t configured on the server yet (missing RESEND_API_KEY).'
        : 'Batch generate failed. Check console for details.';
      window.alert(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (!busy && e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ width: 640, maxWidth: '94vw', maxHeight: '88vh', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Receipt size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            {result
              ? 'Invoice summary — results'
              : `Invoice summary — ${loads.length} load${loads.length === 1 ? '' : 's'}, ${moneyFmt.format(totalAmount)}`
            }
          </div>
          <button onClick={onClose} disabled={busy} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)] disabled:opacity-50">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm overflow-y-auto flex-1">
          {!result && (
            <>
              {missingEmail && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>Some customers have no saved AP email — their invoices will be created but skipped at the send step.</span>
                </div>
              )}
              {hasPortal && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    Portal customers won't get an email — their invoices flip to <strong>Sent</strong> so you can upload the packet to the portal yourself. Turn on <em>Bcc me a copy</em> to get the packet emailed to yourself.
                  </span>
                </div>
              )}

              <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--gc-border-light)' }}>
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr style={{ background: 'var(--gc-bg)' }}>
                      <Th>Customer</Th>
                      <Th>Load #</Th>
                      <Th align="right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {loads.map(l => {
                      const customer = (() => {
                        if (l.customerId) return customerById.get(l.customerId);
                        const broker = l.broker?.trim();
                        if (!broker) return undefined;
                        const lower = broker.toLowerCase();
                        const matches = Array.from(customerById.values()).filter(c =>
                          c.name.toLowerCase() === lower ||
                          (c.aliases ?? []).some(a => a.toLowerCase() === lower),
                        );
                        return matches.length === 1 ? matches[0] : undefined;
                      })();
                      const brokerName = customer?.name ?? l.broker ?? '—';
                      const method = customer?.invoiceMethod ?? 'email';
                      const noEmail = customer && method === 'email' && !customer.invoiceEmail;
                      let destination: { label: string; tone: 'normal' | 'missing' | 'portal' } | null = null;
                      if (customer) {
                        if (method === 'portal') {
                          destination = { label: `Portal: ${customer.invoicePortal ?? '(no portal saved)'}`, tone: 'portal' };
                        } else if (customer.invoiceEmail) {
                          destination = { label: customer.invoiceEmail, tone: 'normal' };
                        } else {
                          destination = { label: 'No email saved', tone: 'missing' };
                        }
                      }
                      return (
                        <tr key={l.loadId} style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                          <Td>
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-1.5">
                                {customer ? (
                                  <button onClick={() => onOpenBroker(customer.id)}
                                    className="text-left hover:underline" style={{ color: 'var(--gc-text-1)' }}>
                                    {brokerName}
                                  </button>
                                ) : <span style={{ color: 'var(--gc-text-3)' }}>{brokerName}</span>}
                                {willSend && noEmail && (
                                  <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full"
                                    style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>No email</span>
                                )}
                              </div>
                              {destination && (
                                <div className="text-[11px] truncate"
                                  style={{
                                    color: destination.tone === 'missing' ? '#991b1b'
                                         : destination.tone === 'portal'  ? '#1d4ed8'
                                         : 'var(--gc-text-3)',
                                  }}
                                  title={destination.label}>
                                  {destination.label}
                                </div>
                              )}
                            </div>
                          </Td>
                          <Td className="tabular-nums">
                            {l.loadNum ? (
                              <div className="flex flex-col gap-0.5">
                                <span style={{ color: 'var(--gc-text-1)' }}>{l.loadNum}</span>
                                <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                                  #{l.internalLoadId}
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--gc-text-1)' }}>#{l.internalLoadId}</span>
                            )}
                          </Td>
                          <Td align="right" className="tabular-nums font-semibold">
                            <span style={{ color: '#15803d' }}>{
                              (l.totalBillable ?? l.loadPrice) != null
                                ? moneyFmt.format(l.totalBillable ?? l.loadPrice!)
                                : '—'
                            }</span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: 'var(--gc-bg)', borderTop: '2px solid var(--gc-border-light)' }}>
                      <Td>
                        <span className="text-[11px] font-extrabold uppercase tracking-wider" style={{ color: 'var(--gc-text-2)' }}>
                          Total
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span style={{ color: 'var(--gc-text-3)' }}>
                          {loads.length} {loads.length === 1 ? 'load' : 'loads'}
                        </span>
                      </Td>
                      <Td align="right" className="tabular-nums font-extrabold">
                        <span style={{ color: '#15803d' }}>{moneyFmt.format(totalAmount)}</span>
                      </Td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {willSend && (
                <div className="space-y-2 pt-1">
                  <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
                    <input type="checkbox" checked={attachLoadDocs} onChange={e => setAttach(e.target.checked)} disabled={busy} />
                    Attach POD / BOL / lumper / scale docs to each packet
                  </label>
                  <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
                    <input type="checkbox" checked={bccSelf} onChange={e => setBccSelf(e.target.checked)} disabled={busy} />
                    Bcc me a copy of every email
                  </label>
                </div>
              )}
            </>
          )}

          {result && <BatchGenerateResultView result={result} />}
        </div>

        <div className="px-5 py-3 flex items-center justify-between gap-2 shrink-0" style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          {!result ? (
            <>
              <button onClick={onClose} disabled={busy}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                Clear All
              </button>
              <div className="flex items-center gap-2">
                {action === 'generateSend' ? (
                  <button onClick={() => setAction('generate')} disabled={busy}
                    className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    style={{ background: 'var(--gc-surface)', color: '#1a73e8', border: '1px solid #bfdbfe' }}>
                    Generate Invoice
                  </button>
                ) : (
                  <button onClick={() => setAction('generateSend')} disabled={busy}
                    className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    style={{ background: 'var(--gc-surface)', color: '#1a73e8', border: '1px solid #bfdbfe' }}>
                    Create &amp; Send
                  </button>
                )}
                <button onClick={() => void handleGo()} disabled={busy}
                  className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                  style={{ background: '#1a73e8', color: '#fff' }}>
                  {busy
                    ? <Loader2 size={12} className="animate-spin inline mr-1.5" />
                    : (willSend ? <Send size={12} className="inline mr-1.5" /> : <FilePlus size={12} className="inline mr-1.5" />)
                  }
                  {willSend ? 'Create & Send' : 'Generate Invoice'}
                </button>
              </div>
            </>
          ) : (
            <button onClick={onComplete}
              className="ml-auto text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BatchGenerateResultView({ result }: { result: BatchGenerateInvoicesResponse }) {
  return (
    <div className="space-y-3">
      {result.created.length > 0 && (
        <ResultStrip tone={{ bg: '#dcfce7', fg: '#166534', border: '#86efac' }}
          label={`${result.created.length} invoice${result.created.length === 1 ? '' : 's'} generated`} />
      )}
      {result.failed.length > 0 && (
        <div className="space-y-1">
          <ResultStrip tone={{ bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' }} label={`${result.failed.length} failed`} />
          <ul className="text-[11.5px] pl-3 space-y-0.5" style={{ color: '#991b1b' }}>
            {result.failed.map(f => <li key={f.loadId}>• {f.error}</li>)}
          </ul>
        </div>
      )}
      {result.sent && result.sent.length > 0 && (
        <div className="space-y-1.5">
          {result.sent.map((g, i) => {
            const tone =
              g.status === 'sent'                ? { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: `Sent · ${g.invoiceIds.length}` } :
              g.status === 'sent_portal'         ? { bg: '#dbeafe', fg: '#1e40af', border: '#bfdbfe', label: 'Portal — marked sent' } :
              g.status === 'skipped_no_email'    ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no AP email' } :
              g.status === 'skipped_no_customer' ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no customer' } :
                                                   { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Failed' };
            return (
              <div key={i} className="px-3 py-2 rounded-lg flex items-center justify-between gap-3"
                style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-[12.5px] truncate">{g.brokerName}</span>
                    {g.loadNumber && (
                      <span className="text-[11px] font-mono tabular-nums opacity-70 shrink-0">
                        #{g.loadNumber}
                      </span>
                    )}
                  </div>
                  <div className="text-[11.5px] opacity-80 truncate">{g.to ?? '—'}</div>
                  {g.error && <div className="text-[11.5px] opacity-90 mt-0.5">{g.error}</div>}
                </div>
                <div className="text-[12px] font-semibold uppercase tracking-wide shrink-0">{tone.label}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResultStrip({ tone, label }: { tone: { bg: string; fg: string; border: string }; label: string }) {
  return (
    <div className="px-3 py-2 rounded-lg text-[12.5px] font-semibold"
      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
      {label}
    </div>
  );
}

// ── Batch Send Dialog ───────────────────────────────────────────────────

export interface BatchSendDialogProps {
  /** Each invoice pre-paired with the broker the table currently shows
   *  for it. The parent resolves this via findCustomerForLoad — falling
   *  back to load.broker name match when the invoice's frozen
   *  customer_id is null. */
  rows:         Array<{ invoice: Invoice; broker: Customer | null }>;
  /** 'send' = draft → sent (default). 'resend' = re-send already-sent
   *  invoices (refreshes sent_at, status stays sent). */
  mode?:        'send' | 'resend';
  onOpenBroker?: (brokerId: string) => void;
  onClose:      () => void;
  onComplete:   () => void;
}

export function BatchSendDialog({ rows, mode = 'send', onOpenBroker, onClose, onComplete }: BatchSendDialogProps) {
  const [bccSelf, setBccSelf]       = useState(true);
  const [attachLoadDocs, setAttach] = useState(true);
  const [busy, setBusy]             = useState(false);
  const [result, setResult]         = useState<BatchSendInvoicesResponse | null>(null);

  const invoices = useMemo(() => rows.map(r => r.invoice), [rows]);

  const groups = useMemo(() => {
    const byBroker = new Map<string, { broker: Customer | null; rows: Invoice[] }>();
    for (const { invoice, broker } of rows) {
      const key = broker?.id ?? '__missing__';
      const cur = byBroker.get(key);
      if (cur) cur.rows.push(invoice);
      else byBroker.set(key, { broker, rows: [invoice] });
    }
    return Array.from(byBroker.values());
  }, [rows]);

  const missingBroker = groups.some(g => !g.broker);
  const missingEmail  = groups.some(g =>
    g.broker && (g.broker.invoiceMethod ?? 'email') === 'email' && !g.broker.invoiceEmail,
  );
  const hasPortal     = groups.some(g => g.broker?.invoiceMethod === 'portal');

  async function handleSend() {
    setBusy(true);
    try {
      const res = mode === 'resend'
        ? await railway.batchResendInvoices({ invoiceIds: invoices.map(i => i.id), bccSelf, attachLoadDocs })
        : await railway.batchSendInvoices({ invoiceIds: invoices.map(i => i.id), bccSelf, attachLoadDocs });
      setResult(res);
    } catch (err) {
      console.error(`[batch${mode === 'resend' ? 'Resend' : 'Send'}] failed:`, err);
      window.alert(`Batch ${mode === 'resend' ? 're' : ''}send failed. Check console for details.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={busy ? undefined : onClose}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ width: 620, maxWidth: '94vw', maxHeight: '88vh', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Send size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            {result
              ? (mode === 'resend' ? 'Batch resend results' : 'Batch send results')
              : `${mode === 'resend' ? 'Resend' : 'Send'} ${invoices.length} invoice${invoices.length === 1 ? '' : 's'} — ${groups.length} customer${groups.length === 1 ? '' : 's'}`}
          </div>
          <button onClick={onClose} disabled={busy} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)] disabled:opacity-50">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm overflow-y-auto flex-1">
          {!result && (
            <>
              {missingBroker && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Some selected invoices have no broker set. Open them individually to fix.
                </div>
              )}
              {missingEmail && !missingBroker && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Some brokers have no saved AP email — their invoices will be skipped.
                </div>
              )}
              {hasPortal && !missingBroker && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Portal brokers won&apos;t get an email — their invoices flip to <strong>Sent</strong> so you can upload the packet to the portal yourself. Turn on <em>Bcc me a copy</em> to get the packet emailed to yourself.
                </div>
              )}

              <div className="space-y-2">
                {groups.map((g, i) => (
                  <div key={i} className="px-3 py-2 rounded-lg" style={{ border: '1px solid var(--gc-border-light)' }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        {g.broker ? (
                          onOpenBroker ? (
                            <button onClick={() => onOpenBroker(g.broker!.id)}
                              className="font-semibold text-[13px] truncate hover:underline"
                              style={{ color: '#1a73e8' }}>
                              {g.broker.name}
                            </button>
                          ) : (
                            <div className="font-semibold text-[13px] truncate" style={{ color: 'var(--gc-text-1)' }}>{g.broker.name}</div>
                          )
                        ) : (
                          <div className="font-semibold text-[13px] truncate" style={{ color: '#dc2626' }}>(no customer set)</div>
                        )}
                        <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                          {(() => {
                            if (g.broker?.invoiceMethod === 'portal') {
                              const portal = g.broker.invoicePortal?.trim();
                              return (
                                <span style={{ color: '#1e40af' }}>
                                  Portal{portal ? `: ${portal}` : ' — marked sent, upload manually'}
                                </span>
                              );
                            }
                            if (g.broker?.invoiceEmail) return g.broker.invoiceEmail;
                            return (
                              <span style={{ color: '#9a3412' }}>
                                (no AP email — {onOpenBroker && g.broker ? (
                                  <button onClick={() => onOpenBroker(g.broker!.id)} className="underline font-semibold">fix in profile</button>
                                ) : 'set one in profile'})
                              </span>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="text-[12px] text-right shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                        {g.rows.length} invoice{g.rows.length === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
                  <input type="checkbox" checked={attachLoadDocs} onChange={e => setAttach(e.target.checked)} disabled={busy} />
                  Attach POD / BOL / lumper / scale docs to each packet
                </label>
                <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
                  <input type="checkbox" checked={bccSelf} onChange={e => setBccSelf(e.target.checked)} disabled={busy} />
                  Bcc me a copy of every email
                </label>
              </div>
            </>
          )}

          {result && (
            <div className="space-y-2">
              {result.groups.map((g, i) => {
                const tone =
                  g.status === 'sent'              ? { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: 'Sent' } :
                  g.status === 'skipped_no_email'  ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no AP email' } :
                                                     { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Failed' };
                return (
                  <div key={i} className="px-3 py-2 rounded-lg" style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-[13px] truncate">{g.brokerName}</div>
                        <div className="text-[11.5px] opacity-80 truncate">{g.to ?? '—'}</div>
                        {g.error && <div className="text-[11.5px] opacity-90 mt-0.5">{g.error}</div>}
                      </div>
                      <div className="text-[12px] text-right shrink-0 font-semibold uppercase tracking-wide">{tone.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2 shrink-0" style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          {!result ? (
            <>
              <button onClick={onClose} disabled={busy}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                Cancel
              </button>
              <button onClick={() => void handleSend()} disabled={busy || missingBroker}
                className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: '#1a73e8', color: '#fff' }}>
                {busy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Send size={12} className="inline mr-1.5" />}
                {mode === 'resend' ? 'Resend' : 'Send'}
              </button>
            </>
          ) : (
            <button onClick={onComplete}
              className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
