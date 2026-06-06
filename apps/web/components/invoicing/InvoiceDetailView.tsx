'use client';

/**
 * InvoiceDetailView — the full invoice review/action UI, decoupled
 * from how it's framed (page route vs modal).
 *
 * Powers:
 *   - /accounting/invoices/[id] (page route, mode='page')
 *   - InvoiceDetailModal in closeout (mode='modal')
 *
 * Owns its own data fetch and lifecycle (status transitions, PDF
 * downloads, email dialog). The wrapper just provides chrome
 * (header back button vs close button) and decides whether the
 * email dialog should auto-open on mount (used by the page's
 * ?send=1 generate-and-send flow).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import {
  ArrowLeft, Download, Send, Mail, Check, X, Loader2,
  AlertTriangle, AlertCircle, Paperclip, ExternalLink as ExternalLinkIcon,
} from 'lucide-react';
import type { Invoice, Customer } from '@fleetcal/types';
import { railway, RailwayError } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

interface Props {
  invoiceId:       string;
  /** 'page' → renders fixed-position back button; 'modal' → close button. */
  mode:            'page' | 'modal';
  /** Page mode: navigates back. Modal mode: closes the dialog. */
  onClose:         () => void;
  /** When true, open the email dialog as soon as the invoice loads
   *  (used by /accounting/invoices/[id]?send=1). */
  autoOpenEmail?:  boolean;
  /** Notify parent when the user clicks the broker name. Page route
   *  shows BrokerProfileModal locally; the closeout-modal variant
   *  bubbles up so closeout's existing modal stack handles it. */
  onBrokerClick?:  (brokerId: string) => void;
}

export function InvoiceDetailView({
  invoiceId, mode, onClose, autoOpenEmail, onBrokerClick,
}: Props) {
  // Same Clerk readiness gate as the closeout + accounting pages:
  // RailwayClientProvider wires the token in a useEffect that runs
  // after children's effects, so a hard refresh of /accounting/
  // invoices/[id] fires authed fetches before the token exists and
  // the API 401s. Hold all requests until auth is loaded + signed in.
  const { isLoaded: authLoaded, isSignedIn } = useAuth();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState<'send' | 'paid' | 'unpaid' | 'void' | 'email' | 'generate' | null>(null);
  // Signed URL for the most recently generated packet — set on
  // successful "Generate" so the user can click View/Download to
  // preview the bytes the broker will receive. Cleared on every send
  // (the server rebuilds the packet at send-time, so any prior URL
  // points at a now-superseded artifact).
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState<'download-packet' | 'download-invoice' | 'view-invoice' | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  // Inline broker-picker for invoices that were generated from a
  // load whose customer wasn't matched. When the user opens such an
  // invoice and there's no broker, they get a "Set broker" button
  // that flips this to true and renders an inline select right above
  // the action buttons.
  const [brokerPickerOpen, setBrokerPickerOpen] = useState(false);
  const [brokerPickerValue, setBrokerPickerValue] = useState<string>('');

  // Inline PDF state. We fetch the packet PDF as a blob via the authed
  // client, then mount it in an iframe — the browser's built-in PDF
  // viewer is the canvas. `pdfRefresh` increments whenever something
  // mutates the underlying file (send / mark-paid / void) so the
  // view reflects the current persisted artifact.
  const [packetUrl, setPacketUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [pdfError, setPdfError]     = useState<string | null>(null);
  const [pdfRefresh, setPdfRefresh] = useState(0);

  const customers = useCalendarStore(s => s.customers);
  const broker: Customer | undefined = useMemo(() => {
    if (!invoice?.customerId) return undefined;
    return customers.find(c => c.id === invoice.customerId);
  }, [invoice?.customerId, customers]);

  useEffect(() => {
    if (!invoiceId) return;
    if (!authLoaded || !isSignedIn) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    railway.getInvoice(invoiceId)
      .then((res) => { if (!cancelled) setInvoice(res.invoice); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load invoice'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [invoiceId, authLoaded, isSignedIn]);

  // Inline-PDF fetch. Runs on first load + whenever something mutates
  // the persisted packet. Old blob URLs are revoked synchronously when
  // a fresh one lands so memory doesn't leak across long sessions.
  useEffect(() => {
    if (!invoiceId) return;
    if (!authLoaded || !isSignedIn) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setPdfLoading(true);
    setPdfError(null);
    railway.getInvoicePacketBlob(invoiceId)
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        // Revoke whatever the previous render put up before we swap
        // so the user doesn't see a flash of "blank then PDF".
        setPacketUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return createdUrl;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof RailwayError && err.status === 404
          ? 'Invoice PDF not available yet.'
          : 'Failed to load invoice PDF.';
        setPdfError(msg);
        console.error('[invoice] packet fetch failed:', err);
      })
      .finally(() => { if (!cancelled) setPdfLoading(false); });
    return () => {
      cancelled = true;
      // The blob URL set in this effect lives on until the next run
      // revokes it (above) — don't revoke here, the iframe may still
      // be reading. If the user navigates away entirely, browser GC
      // handles it.
    };
  }, [invoiceId, pdfRefresh, authLoaded, isSignedIn]);

  // Final cleanup on unmount — any lingering blob URL gets released.
  useEffect(() => () => {
    setPacketUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return null;
    });
  }, []);

  // Auto-open the email dialog on the generate-and-send flow. Gated on
  // status so a stale ?send=1 doesn't pop the dialog for a sent invoice.
  useEffect(() => {
    if (!autoOpenEmail || !invoice) return;
    if (invoice.status === 'draft') setEmailOpen(true);
  }, [autoOpenEmail, invoice]);

  async function handleMarkSentManual() {
    if (!invoice) return;
    setBusy('send');
    try {
      const { invoice: updated } = await railway.sendInvoice(invoice.id, { method: 'manual' });
      setInvoice(updated);
      setPdfRefresh(n => n + 1);
      // Server moved loads.billing_status from 'released' → 'invoiced'.
      // Bump so the accounting/closeout snapshots re-sync silently and
      // the row slides into the next bucket without a manual refresh.
      useCalendarStore.getState().bumpLoadEditTick();
    } catch (err) {
      console.error('[invoice] send failed:', err);
      window.alert('Failed to mark invoice sent.');
    } finally {
      setBusy(null);
    }
  }

  // Build + persist the merged PDF packet without sending. The signed
  // URL goes into `generatedUrl` so the View / Download buttons can
  // hand it back to the user for review. /send always rebuilds fresh
  // at send-time so editing the invoice between Generate and Send
  // can't produce a stale email.
  // Assign / reassign the broker on a draft invoice. Used when the
  // generating load didn't have a customer matched, leaving the
  // invoice with no broker → no recipient → can't send. The API
  // also refreshes the snapshot's brokerName/MC# so the printed
  // invoice and the email target stay aligned.
  async function handleSetBroker(customerId: string) {
    if (!invoice || !customerId) return;
    try {
      const { invoice: updated } = await railway.updateInvoice(invoice.id, { customerId });
      setInvoice(updated);
      setBrokerPickerOpen(false);
      setBrokerPickerValue('');
      setPdfRefresh(n => n + 1);
    } catch (err) {
      console.error('[invoice] set-broker failed:', err);
      window.alert('Failed to set broker. Check console for details.');
    }
  }

  async function handleGeneratePacket() {
    if (!invoice) return;
    setBusy('generate');
    try {
      const { signedUrl } = await railway.generateInvoicePacket(invoice.id);
      setGeneratedUrl(signedUrl);
      // Refresh the inline preview iframe so the user sees the
      // freshly-rendered packet immediately.
      setPdfRefresh(n => n + 1);
    } catch (err) {
      console.error('[invoice] generate failed:', err);
      window.alert('Failed to generate invoice packet. Check console for details.');
    } finally {
      setBusy(null);
    }
  }

  async function handleEmailSend(args: {
    to: string;
    cc?: string[];
    bccSelf: boolean;
    bodyText?: string;
    attachLoadDocs: boolean;
  }) {
    if (!invoice) return;
    setBusy('email');
    try {
      const { invoice: updated } = await railway.sendInvoice(invoice.id, {
        method:         'email',
        to:             args.to,
        cc:             args.cc?.length ? args.cc : undefined,
        bccSelf:        args.bccSelf,
        bodyText:       args.bodyText?.trim() ? args.bodyText : undefined,
        attachLoadDocs: args.attachLoadDocs,
      });
      setInvoice(updated);
      setEmailOpen(false);
      // The server rebuilt + persisted a fresh packet during /send,
      // so any prior "View generated packet" URL points at an
      // obsolete artifact. Drop it.
      setGeneratedUrl(null);
      setPdfRefresh(n => n + 1);
      // Email send moved loads.billing_status forward; notify holders
      // of cached load snapshots (accounting/closeout/timeline) so the
      // row slides into the Invoiced bucket without a manual refresh.
      useCalendarStore.getState().bumpLoadEditTick();
    } catch (err) {
      console.error('[invoice] email send failed:', err);
      const msg = err instanceof RailwayError && err.status === 503
        ? 'Email is not configured on the server yet (missing RESEND_API_KEY).'
        : 'Email send failed. Check console for details.';
      window.alert(msg);
    } finally {
      setBusy(null);
    }
  }

  async function handleMarkPaid() {
    if (!invoice) return;
    setBusy('paid');
    try {
      const { invoice: updated } = await railway.markInvoicePaid(invoice.id, {});
      setInvoice(updated);
      // Server moved loads.billing_status to 'paid' — sync cached pages.
      useCalendarStore.getState().bumpLoadEditTick();
    } catch (err) {
      console.error('[invoice] mark-paid failed:', err);
      window.alert('Failed to mark invoice paid.');
    } finally {
      setBusy(null);
    }
  }

  /** Reverse a mark-paid. Prompts for a reason (e.g. "bounced check",
   *  "wrong invoice marked") and rolls the load back into the Invoiced
   *  bucket. Server is the source of truth for state transitions —
   *  bumpLoadEditTick fires so cached snapshots re-sync silently. */
  async function handleUnmarkPaid() {
    if (!invoice) return;
    const ok = window.confirm(
      'Unmark this invoice as paid? The load will return to the Invoiced bucket.'
    );
    if (!ok) return;
    const reason = window.prompt('Reason for the payment reversal (optional):') ?? undefined;
    setBusy('unpaid');
    try {
      const { invoice: updated } = await railway.unmarkInvoicePaid(invoice.id, reason ? { reason } : {});
      setInvoice(updated);
      useCalendarStore.getState().bumpLoadEditTick();
    } catch (err) {
      console.error('[invoice] unmark-paid failed:', err);
      window.alert('Failed to unmark invoice paid.');
    } finally {
      setBusy(null);
    }
  }

  // PDF actions. The packet is shown inline in the iframe; these
  // handlers cover the explicit download + the standalone-invoice
  // preview that opens in a new tab.
  async function fetchPdf(
    label: 'download-packet' | 'download-invoice' | 'view-invoice',
    fetcher: (opts: { asDownload?: boolean }) => Promise<Blob>,
    filename: string,
    asDownload: boolean,
  ) {
    if (!invoice || pdfBusy) return;
    setPdfBusy(label);
    try {
      const blob = await fetcher({ asDownload });
      const url = URL.createObjectURL(blob);
      if (asDownload) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      } else {
        const win = window.open(url, '_blank', 'noopener');
        if (!win) window.alert('Pop-up blocked. Enable pop-ups for this site to view the PDF.');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (err) {
      console.error('[invoice]', label, 'failed:', err);
      window.alert('Failed to open PDF.');
    } finally {
      setPdfBusy(null);
    }
  }

  const handleDownloadPacket = () =>
    invoice && fetchPdf('download-packet', (o) => railway.getInvoicePacketBlob(invoice.id, o), `invoice-packet-${invoice.invoiceNumber}.pdf`, true);
  const handleViewInvoice = () =>
    invoice && fetchPdf('view-invoice', (o) => railway.getInvoicePdfBlob(invoice.id, o), `invoice-${invoice.invoiceNumber}.pdf`, false);

  async function handleVoid() {
    if (!invoice) return;
    const reason = window.prompt('Void reason (optional):') ?? undefined;
    setBusy('void');
    try {
      const { invoice: updated } = await railway.voidInvoice(invoice.id, reason ? { reason } : {});
      setInvoice(updated);
      setPdfRefresh(n => n + 1);
      // Voiding drops the load back to its prior bucket (typically
      // 'released'); cached snapshots need a silent re-sync.
      useCalendarStore.getState().bumpLoadEditTick();
    } catch (err) {
      console.error('[invoice] void failed:', err);
      window.alert('Failed to void invoice.');
    } finally {
      setBusy(null);
    }
  }

  function fmtDate(iso?: string) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div style={{ background: 'var(--gc-bg)', minHeight: mode === 'page' ? '100vh' : undefined, height: mode === 'modal' ? '100%' : undefined, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="px-6 py-4 flex items-center gap-3 shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
        <button onClick={onClose}
          className="p-2 rounded-lg transition-colors hover:bg-[var(--gc-hover)]"
          title={mode === 'modal' ? 'Close' : 'Back'}>
          {mode === 'modal' ? <X size={16} /> : <ArrowLeft size={16} />}
        </button>
        <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
          Invoice {invoice?.invoiceNumber ? `#${invoice.invoiceNumber}` : ''}
        </div>
        {invoice && <StatusPill status={invoice.status} />}
        <div className="ml-auto flex items-center gap-2">
          {/* Invoice-only opens the standalone PDF in a new tab. The
              main canvas always shows the packet (broker-facing). */}
          <button onClick={handleViewInvoice}
            className="text-[12px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors hover:bg-[var(--gc-hover)] disabled:opacity-60"
            style={{ color: 'var(--gc-text-3)' }}
            disabled={!invoice || pdfBusy !== null}
            title="Open just the invoice PDF (no rate-con or POD)">
            {pdfBusy === 'view-invoice' ? <Loader2 size={12} className="animate-spin inline mr-1" /> : null}
            Invoice only
          </button>
          <button onClick={handleDownloadPacket}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
            style={{ background: '#1a73e8', color: '#fff' }}
            disabled={!invoice || pdfBusy !== null}
            title="Download the full customer packet (invoice + rate-con + POD)">
            {pdfBusy === 'download-packet'
              ? <Loader2 size={12} className="animate-spin inline mr-1.5" />
              : <Download size={12} className="inline mr-1.5" />}
            Download packet
          </button>
        </div>
      </div>

      <div className="flex gap-6 px-6 py-6 flex-1 overflow-hidden" style={mode === 'page' ? { minHeight: 'calc(100vh - 64px)' } : undefined}>
        {/* Document canvas — embeds the actual rendered packet PDF
            via the browser's built-in viewer. No HTML re-render, no
            drift from what the broker actually gets. */}
        <div className="flex-1 flex justify-center items-stretch min-w-0">
          {loading && <div className="self-center"><Loader2 className="animate-spin" size={20} /></div>}
          {error && (
            <div className="self-center text-center text-sm" style={{ color: 'var(--gc-text-2)' }}>
              <AlertTriangle size={20} style={{ display: 'inline', marginRight: 6, color: '#dc2626' }} />
              {error}
            </div>
          )}
          {invoice && !error && (
            <div className="rounded-xl overflow-hidden relative w-full"
              style={{ background: '#fff', border: '1px solid var(--gc-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.08)', maxWidth: 920 }}>
              {pdfLoading && !packetUrl && (
                <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'var(--gc-bg)' }}>
                  <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
                </div>
              )}
              {pdfError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm p-6 text-center" style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)' }}>
                  <AlertTriangle size={20} style={{ color: '#dc2626' }} />
                  <div>{pdfError}</div>
                  <button onClick={() => setPdfRefresh(n => n + 1)}
                    className="mt-2 text-[12px] font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#1a73e8', color: '#fff' }}>
                    Retry
                  </button>
                </div>
              )}
              {packetUrl && (
                <iframe key={packetUrl}
                  src={packetUrl}
                  title={`Invoice #${invoice.invoiceNumber} packet`}
                  style={{ width: '100%', height: '100%', minHeight: 600, border: 'none', display: 'block' }} />
              )}
            </div>
          )}
        </div>

        {/* Action sidebar */}
        {invoice && (
          <div className="shrink-0" style={{ width: 340 }}>
            <div className="rounded-2xl overflow-hidden sticky top-0"
              style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
              <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Actions</div>
              </div>
              <div className="p-5 space-y-3 text-sm">

                {/* Broker block — name links to profile, recipient
                    email shown so the user can verify at a glance. */}
                <BrokerRecipientBlock
                  broker={broker}
                  invoice={invoice}
                  onBrokerClick={onBrokerClick}
                />

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-3"
                  style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                  <Field label="Total"     value={`$${invoice.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
                  <Field label="Issued"    value={fmtDate(invoice.issuedAt)} />
                  <Field label="Due"       value={fmtDate(invoice.dueAt)} />
                  <Field label="Status"    value={statusLabel(invoice.status)} />
                  {invoice.sentAt && <Field label="Sent" value={fmtDate(invoice.sentAt)} />}
                  {invoice.paidAt && <Field label="Paid" value={fmtDate(invoice.paidAt)} />}
                </div>

                <div className="border-t pt-3 mt-3 space-y-2" style={{ borderColor: 'var(--gc-border-light)' }}>
                  {invoice.status === 'draft' && !broker && (
                    /* No broker on a draft → block sending and offer
                       an inline picker. The generating load didn't
                       have a customer matched, so we let the user
                       pick / create one here without leaving the
                       invoice. */
                    <div className="px-3 py-3 rounded-lg space-y-2"
                      style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                      <div className="flex items-start gap-1.5 text-[12px]">
                        <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>
                          No customer linked to this invoice. Pick one to enable sending.
                        </span>
                      </div>
                      {brokerPickerOpen ? (
                        <div className="space-y-2">
                          <select
                            value={brokerPickerValue}
                            onChange={e => setBrokerPickerValue(e.target.value)}
                            className="w-full text-[12px] px-2 py-1.5 rounded"
                            style={{ border: '1px solid #fecaca', background: '#fff', color: 'var(--gc-text-1)' }}
                            autoFocus
                          >
                            <option value="">— Pick a customer —</option>
                            {[...customers].sort((a, b) => a.name.localeCompare(b.name)).map(c => (
                              <option key={c.id} value={c.id}>
                                {c.name}{c.invoiceEmail ? '' : ' (no AP email)'}
                              </option>
                            ))}
                          </select>
                          <div className="flex gap-2">
                            <button
                              onClick={() => void handleSetBroker(brokerPickerValue)}
                              disabled={!brokerPickerValue}
                              className="flex-1 text-[12px] font-semibold px-3 py-1.5 rounded transition-colors disabled:opacity-60"
                              style={{ background: '#1a73e8', color: '#fff' }}>
                              Save
                            </button>
                            <button
                              onClick={() => { setBrokerPickerOpen(false); setBrokerPickerValue(''); }}
                              className="text-[12px] font-semibold px-3 py-1.5 rounded transition-colors"
                              style={{ background: '#fff', color: '#991b1b', border: '1px solid #fecaca' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setBrokerPickerOpen(true)}
                          className="w-full text-[12px] font-semibold px-3 py-1.5 rounded transition-colors"
                          style={{ background: '#fff', color: '#991b1b', border: '1px solid #fecaca' }}>
                          Set customer
                        </button>
                      )}
                    </div>
                  )}
                  {invoice.status === 'draft' && (
                    <>
                      {/* Generate: build the merged packet without
                          sending. Lets the user review before they
                          click Email — but also optional: Email
                          builds + sends in one shot. */}
                      <button onClick={() => void handleGeneratePacket()} disabled={busy !== null}
                        className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
                        style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-1)', border: '1px solid var(--gc-border)' }}
                        title="Build the merged invoice PDF packet (invoice + rate con + POD/BOL) and save it for review. Doesn't send.">
                        {busy === 'generate'
                          ? <Loader2 size={12} className="animate-spin inline mr-1.5" />
                          : <Download size={12} className="inline mr-1.5" />}
                        {generatedUrl ? 'Regenerate packet' : 'Generate packet'}
                      </button>
                      {generatedUrl && (
                        <a href={generatedUrl} target="_blank" rel="noopener noreferrer"
                          className="w-full block text-center text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors"
                          style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac', textDecoration: 'none' }}>
                          <Check size={12} className="inline mr-1.5" />
                          View generated packet
                        </a>
                      )}
                      <button onClick={() => setEmailOpen(true)}
                        disabled={busy !== null || !broker?.invoiceEmail}
                        className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        style={{ background: '#1a73e8', color: '#fff' }}
                        title={
                          broker?.invoiceEmail
                            ? `Send to ${broker.invoiceEmail} (rebuilds the packet fresh — same process as Generate)`
                            : 'Set this customer\'s invoice email before sending'
                        }>
                        <Mail size={12} className="inline mr-1.5" />
                        {generatedUrl ? 'Send to customer' : 'Generate & email to customer'}
                      </button>
                      <button onClick={() => void handleMarkSentManual()} disabled={busy !== null}
                        className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
                        style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                        title="Skip sending — you already delivered the invoice elsewhere (portal, prior email, etc.)">
                        {busy === 'send' ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Send size={12} className="inline mr-1.5" />}
                        Mark sent manually
                      </button>
                    </>
                  )}
                  {(invoice.status === 'draft' || invoice.status === 'sent') && (
                    <button onClick={() => void handleMarkPaid()} disabled={busy !== null}
                      className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
                      style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}>
                      {busy === 'paid' ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Check size={12} className="inline mr-1.5" />}
                      Mark Paid
                    </button>
                  )}
                  {invoice.status !== 'void' && invoice.status !== 'paid' && (
                    <button onClick={() => void handleVoid()} disabled={busy !== null}
                      className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
                      style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                      {busy === 'void' ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <X size={12} className="inline mr-1.5" />}
                      Void
                    </button>
                  )}
                  {invoice.status === 'paid' && (
                    <>
                      <button onClick={() => void handleUnmarkPaid()} disabled={busy !== null}
                        className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
                        style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
                        title="Reverse the payment — load returns to the Invoiced bucket">
                        {busy === 'unpaid' ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <X size={12} className="inline mr-1.5" />}
                        Unmark Paid
                      </button>
                      <div className="text-[11px] text-center" style={{ color: 'var(--gc-text-3)' }}>
                        Use this if payment bounced or the wrong invoice was marked.
                      </div>
                    </>
                  )}
                  {invoice.status === 'void' && (
                    <div className="text-[12px] text-center py-2" style={{ color: 'var(--gc-text-3)' }}>
                      Invoice voided{invoice.voidReason ? `: ${invoice.voidReason}` : ''}.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {invoice && emailOpen && (
        <EmailInvoiceDialog
          invoice={invoice}
          broker={broker}
          busy={busy === 'email'}
          onClose={() => setEmailOpen(false)}
          onSend={(args) => void handleEmailSend(args)}
        />
      )}
    </div>
  );
}

// ─── Broker recipient block ─────────────────────────────────────────────
//
// Shows who the invoice is going to. Top of the sidebar so the user
// can verify the recipient before clicking send. Broker name is a
// link → broker profile so they can fix invoice settings in one
// click if the email is missing.

function BrokerRecipientBlock({
  broker, invoice, onBrokerClick,
}: {
  broker: Customer | undefined;
  invoice: Invoice;
  onBrokerClick: ((brokerId: string) => void) | undefined;
}) {
  const brokerName = broker?.name ?? invoice.snapshot.brokerName ?? '(no customer set)';
  const recipient  = broker?.invoiceEmail?.trim();

  // method defaults to 'email' on new customers per Phase 4 — if it's
  // unset we treat it as email but surface a hint that the user can
  // change it.
  const method = broker?.invoiceMethod ?? 'email';

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
        Send to
      </div>
      {broker && onBrokerClick ? (
        <button
          onClick={() => onBrokerClick(broker.id)}
          className="text-[13px] font-semibold flex items-center gap-1 hover:underline"
          style={{ color: '#1a73e8' }}
          title="Open customer profile">
          {brokerName}
          <ExternalLinkIcon size={11} />
        </button>
      ) : (
        <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
          {brokerName}
        </div>
      )}
      {/* The recipient email (or a warning if missing) */}
      {method === 'portal' ? (
        <div className="text-[12px] flex items-start gap-1.5" style={{ color: 'var(--gc-text-2)' }}>
          <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 2, color: '#9a3412' }} />
          <span>
            Customer uses a portal (not email).
            {broker?.invoicePortal && <> {broker.invoicePortal}</>}
            <br/>Use <strong>Mark sent manually</strong> after uploading to their portal.
          </span>
        </div>
      ) : recipient ? (
        <div className="text-[12px] font-medium tabular-nums break-all" style={{ color: 'var(--gc-text-1)' }}>
          {recipient}
        </div>
      ) : (
        <div className="px-2.5 py-2 rounded-lg flex items-start gap-1.5 text-[12px]"
          style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            No invoice email saved for this customer.{' '}
            {broker && onBrokerClick && (
              <button onClick={() => onBrokerClick(broker.id)}
                className="underline font-semibold">
                Open customer profile
              </button>
            )}
            {(!broker || !onBrokerClick) && 'Set one in the customer profile to enable Email to customer.'}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Sub-pieces ─────────────────────────────────────────────────────────

function statusLabel(status: Invoice['status']): string {
  if (status === 'draft') return 'Unsent';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="text-[12px] font-medium tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{value}</div>
    </>
  );
}

function StatusPill({ status }: { status: Invoice['status'] }) {
  const palette: Record<Invoice['status'], { bg: string; fg: string; border: string; label: string }> = {
    draft: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1', label: 'Unsent' },
    sent:  { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', label: 'Sent'   },
    paid:  { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: 'Paid'   },
    void:  { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Void'   },
  };
  const p = palette[status];
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
      style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>
      {p.label}
    </span>
  );
}

// ─── Email dialog (unchanged shape; lives here so the modal route owns it) ──

interface EmailDialogProps {
  invoice:    Invoice;
  broker:     Customer | undefined;
  busy:       boolean;
  onClose:    () => void;
  onSend:     (args: { to: string; cc?: string[]; bccSelf: boolean; bodyText?: string; attachLoadDocs: boolean }) => void;
}

function EmailInvoiceDialog({ invoice, broker, busy, onClose, onSend }: EmailDialogProps) {
  const [to, setTo]                   = useState(broker?.invoiceEmail ?? '');
  const [ccText, setCcText]           = useState('');
  const [bccSelf, setBccSelf]         = useState(true);
  const [attachLoadDocs, setAttach]   = useState(true);
  const [bodyText, setBodyText]       = useState('');

  function parseCc(s: string): string[] {
    return s.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  }

  const canSend = !busy && /.+@.+\..+/.test(to.trim());

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}>
      <div className="rounded-2xl overflow-hidden"
        style={{ width: 520, maxWidth: '92vw', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Mail size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            Email invoice #{invoice.invoiceNumber} to customer
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)]" disabled={busy}>
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm">
          <Row label="To">
            <input type="email"
              value={to}
              onChange={e => setTo(e.target.value)}
              placeholder={broker?.invoiceEmail ?? 'ap@customer.com'}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }} />
            {!broker?.invoiceEmail && broker?.name && (
              <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                No saved AP email for {broker.name}. Add one in the customer profile to skip this step next time.
              </div>
            )}
          </Row>
          <Row label="Cc">
            <input type="text"
              value={ccText}
              onChange={e => setCcText(e.target.value)}
              placeholder="Optional. Separate multiple with commas."
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }} />
          </Row>
          <Row label="Body">
            <textarea
              value={bodyText}
              onChange={e => setBodyText(e.target.value)}
              placeholder="Leave blank to auto-generate from the invoice."
              rows={5}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', fontFamily: 'inherit', resize: 'vertical' }} />
          </Row>

          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
              <input type="checkbox" checked={attachLoadDocs} onChange={e => setAttach(e.target.checked)} disabled={busy} />
              <Paperclip size={12} />
              Attach POD / BOL / lumper / scale docs for this load
            </label>
            <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
              <input type="checkbox" checked={bccSelf} onChange={e => setBccSelf(e.target.checked)} disabled={busy} />
              Bcc me a copy
            </label>
          </div>
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <button onClick={onClose} disabled={busy}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
            style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
            Cancel
          </button>
          <button onClick={() => onSend({
              to:             to.trim(),
              cc:             parseCc(ccText),
              bccSelf,
              bodyText,
              attachLoadDocs,
            })}
            disabled={!canSend}
            className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
            style={{ background: '#1a73e8', color: '#fff' }}>
            {busy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Send size={12} className="inline mr-1.5" />}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid items-start gap-2" style={{ gridTemplateColumns: '60px 1fr' }}>
      <div className="text-[12px] font-semibold pt-2.5" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}
