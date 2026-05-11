'use client';

/**
 * /accounting/invoices/[id] — single invoice view.
 *
 * Two-column layout: the rendered InvoiceDocument fills the canvas on
 * the left, an action sidebar on the right. The sidebar's controls
 * adapt to status: draft → Send / Edit / Void, sent → Mark Paid / Void,
 * paid / void → read-only.
 *
 * "Print" uses the browser print stylesheet — Phase-4 will swap in a
 * server-side PDF renderer for email delivery.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useOrganization } from '@clerk/nextjs';
import { ArrowLeft, Download, ExternalLink, Send, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import type { Invoice } from '@fleetcal/types';
import { railway } from '@/lib/railway';
import { InvoiceDocument } from '@/components/invoicing/InvoiceDocument';

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { organization } = useOrganization();
  const id = params?.id as string;

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState<'send' | 'paid' | 'void' | null>(null);
  const [pdfBusy, setPdfBusy] = useState<'download' | 'view' | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    railway.getInvoice(id)
      .then((res) => { if (!cancelled) setInvoice(res.invoice); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load invoice'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  async function handleSend() {
    if (!invoice) return;
    setBusy('send');
    try {
      const { invoice: updated } = await railway.sendInvoice(invoice.id, { method: 'manual' });
      setInvoice(updated);
    } catch (err) {
      console.error('[invoice] send failed:', err);
      window.alert('Failed to mark invoice sent.');
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
    } catch (err) {
      console.error('[invoice] mark-paid failed:', err);
      window.alert('Failed to mark invoice paid.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDownloadPdf() {
    if (!invoice || pdfBusy) return;
    setPdfBusy('download');
    try {
      const blob = await railway.getInvoicePdfBlob(invoice.id, { asDownload: true });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${invoice.invoiceNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Release the blob asynchronously so the click handler has time
      // to start the download (some browsers race on immediate revoke).
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      console.error('[invoice] download pdf failed:', err);
      window.alert('Failed to download PDF.');
    } finally {
      setPdfBusy(null);
    }
  }

  async function handleViewPdf() {
    if (!invoice || pdfBusy) return;
    setPdfBusy('view');
    try {
      const blob = await railway.getInvoicePdfBlob(invoice.id);
      const url = URL.createObjectURL(blob);
      // window.open is more reliable than navigating the current tab —
      // the user keeps the detail page open and can close the PDF tab
      // when they're done.
      const win = window.open(url, '_blank', 'noopener');
      if (!win) window.alert('Pop-up blocked. Enable pop-ups for this site to view the PDF.');
      // Don't revoke immediately — the new tab is still rendering.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('[invoice] view pdf failed:', err);
      window.alert('Failed to open PDF.');
    } finally {
      setPdfBusy(null);
    }
  }

  async function handleVoid() {
    if (!invoice) return;
    const reason = window.prompt('Void reason (optional):') ?? undefined;
    setBusy('void');
    try {
      const { invoice: updated } = await railway.voidInvoice(invoice.id, reason ? { reason } : {});
      setInvoice(updated);
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
    <div style={{ background: 'var(--gc-bg)', minHeight: '100vh' }}>
      <div className="px-6 py-4 flex items-center gap-3" style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
        <button onClick={() => router.back()}
          className="p-2 rounded-lg transition-colors hover:bg-[var(--gc-hover)]"
          title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
          Invoice {invoice?.invoiceNumber ? `#${invoice.invoiceNumber}` : ''}
        </div>
        {invoice && <StatusPill status={invoice.status} />}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => void handleViewPdf()}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--gc-hover)] disabled:opacity-60"
            style={{ border: '1px solid var(--gc-border)' }}
            disabled={!invoice || pdfBusy !== null}
            title="Open PDF in a new tab">
            {pdfBusy === 'view'
              ? <Loader2 size={12} className="animate-spin inline mr-1.5" />
              : <ExternalLink size={12} className="inline mr-1.5" />}
            View PDF
          </button>
          <button onClick={() => void handleDownloadPdf()}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
            style={{ background: '#1a73e8', color: '#fff' }}
            disabled={!invoice || pdfBusy !== null}
            title="Download as PDF">
            {pdfBusy === 'download'
              ? <Loader2 size={12} className="animate-spin inline mr-1.5" />
              : <Download size={12} className="inline mr-1.5" />}
            Download PDF
          </button>
        </div>
      </div>

      <div className="flex gap-6 px-6 py-6" style={{ minHeight: 'calc(100vh - 64px)' }}>
        {/* Document canvas */}
        <div className="flex-1 flex justify-center">
          {loading && <Loader2 className="animate-spin" size={20} />}
          {error && (
            <div className="text-center text-sm" style={{ color: 'var(--gc-text-2)' }}>
              <AlertTriangle size={20} style={{ display: 'inline', marginRight: 6, color: '#dc2626' }} />
              {error}
            </div>
          )}
          {invoice && (
            <InvoiceDocument
              snapshot={invoice.snapshot}
              invoiceNumber={invoice.invoiceNumber}
              issuedDate={fmtDate(invoice.issuedAt)}
              dueDate={fmtDate(invoice.dueAt)}
              logoUrl={organization?.imageUrl}
            />
          )}
        </div>

        {/* Action sidebar */}
        {invoice && (
          <div className="shrink-0 print:hidden" style={{ width: 320 }}>
            <div className="rounded-2xl overflow-hidden sticky top-6"
              style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
              <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Actions</div>
              </div>
              <div className="p-5 space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <Field label="Total"     value={`$${invoice.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
                  <Field label="Issued"    value={fmtDate(invoice.issuedAt)} />
                  <Field label="Due"       value={fmtDate(invoice.dueAt)} />
                  <Field label="Status"    value={invoice.status} />
                  {invoice.sentAt   && <Field label="Sent"   value={fmtDate(invoice.sentAt)} />}
                  {invoice.paidAt   && <Field label="Paid"   value={fmtDate(invoice.paidAt)} />}
                </div>

                <div className="border-t pt-3 mt-3 space-y-2" style={{ borderColor: 'var(--gc-border-light)' }}>
                  {invoice.status === 'draft' && (
                    <button onClick={() => void handleSend()} disabled={busy !== null}
                      className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
                      style={{ background: '#1a73e8', color: '#fff' }}>
                      {busy === 'send' ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Send size={12} className="inline mr-1.5" />}
                      Mark Sent
                    </button>
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
                    <div className="text-[12px] text-center py-2" style={{ color: 'var(--gc-text-3)' }}>
                      Invoice paid — no further actions.
                    </div>
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

    </div>
  );
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
  const palette: Record<Invoice['status'], { bg: string; fg: string; border: string }> = {
    draft: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' },
    sent:  { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
    paid:  { bg: '#dcfce7', fg: '#166534', border: '#86efac' },
    void:  { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' },
  };
  const p = palette[status];
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
      style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>
      {status}
    </span>
  );
}
