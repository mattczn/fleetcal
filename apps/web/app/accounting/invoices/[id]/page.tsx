'use client';

/**
 * /accounting/invoices/[id] — single invoice view.
 *
 * Two-column layout: the rendered InvoiceDocument fills the canvas on
 * the left, an action sidebar on the right. The sidebar's controls
 * adapt to status: draft → Email/Mark Sent/Void, sent → Mark Paid/Void,
 * paid / void → read-only.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useOrganization } from '@clerk/nextjs';
import { ArrowLeft, Download, ExternalLink, Send, Mail, Check, X, Loader2, AlertTriangle, Paperclip } from 'lucide-react';
import type { Invoice, Customer } from '@fleetcal/types';
import { railway, RailwayError } from '@/lib/railway';
import { InvoiceDocument } from '@/components/invoicing/InvoiceDocument';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { organization } = useOrganization();
  const id = params?.id as string;

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState<'send' | 'paid' | 'void' | 'email' | null>(null);
  const [pdfBusy, setPdfBusy] = useState<'download' | 'view' | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);

  // Pull broker info from the calendar store so the email dialog can
  // pre-fill the recipient with the saved AP email (customers.invoice_email).
  const customers = useCalendarStore(s => s.customers);
  const broker: Customer | undefined = useMemo(() => {
    if (!invoice?.customerId) return undefined;
    return customers.find(c => c.id === invoice.customerId);
  }, [invoice?.customerId, customers]);

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

  async function handleMarkSentManual() {
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
                    <>
                      <button onClick={() => setEmailOpen(true)} disabled={busy !== null}
                        className="w-full text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
                        style={{ background: '#1a73e8', color: '#fff' }}
                        title={broker?.invoiceEmail ? `Send to ${broker.invoiceEmail}` : 'Send invoice via email'}>
                        <Mail size={12} className="inline mr-1.5" /> Email to broker
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

      {invoice && emailOpen && (
        <EmailInvoiceDialog
          invoice={invoice}
          broker={broker}
          defaultBcc={undefined}
          busy={busy === 'email'}
          onClose={() => setEmailOpen(false)}
          onSend={(args) => void handleEmailSend(args)}
        />
      )}
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

interface EmailDialogProps {
  invoice:    Invoice;
  broker:     Customer | undefined;
  defaultBcc: string | undefined;
  busy:       boolean;
  onClose:    () => void;
  onSend:     (args: { to: string; cc?: string[]; bccSelf: boolean; bodyText?: string; attachLoadDocs: boolean }) => void;
}

function EmailInvoiceDialog({ invoice, broker, busy, onClose, onSend }: EmailDialogProps) {
  // Pre-fill from the broker record. Empty string when missing — the
  // user has to type one and we'll save it back to the customer in a
  // follow-up.
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
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}>
      <div className="rounded-2xl overflow-hidden"
        style={{ width: 520, maxWidth: '92vw', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Mail size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            Email invoice #{invoice.invoiceNumber} to broker
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
              placeholder={broker?.invoiceEmail ?? 'ap@broker.com'}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }} />
            {!broker?.invoiceEmail && broker?.name && (
              <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                No saved AP email for {broker.name}. Add one in the broker profile to skip this step next time.
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
