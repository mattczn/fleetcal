'use client';

/**
 * InvoicePacketViewerModal — minimal "preview" surface for an invoice
 * packet. Renders only the PDF in a popup; no sidebar, no actions.
 *
 * Used by the per-row View button on /accounting when the user just
 * wants to glance at what the broker will/did receive. For full
 * detail + actions (Email / Mark Paid / Void) the row's Invoice #
 * link opens InvoiceDetailModal instead.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Loader2, X, Download, AlertTriangle } from 'lucide-react';
import { railway, RailwayError } from '@/lib/railway';

interface Props {
  invoiceId:      string;
  invoiceNumber?: string;
  onClose:        () => void;
}

export function InvoicePacketViewerModal({ invoiceId, invoiceNumber, onClose }: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const [url, setUrl]         = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Fetch + revoke blob URL on mount / unmount. Same pattern as
  // InvoiceDetailView's inline viewer.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(null);
    railway.getInvoicePacketBlob(invoiceId)
      .then(blob => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof RailwayError && err.status === 404
          ? 'Invoice PDF not available yet.'
          : 'Failed to load invoice PDF.';
        setError(msg);
        console.error('[viewer] fetch failed:', err);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [invoiceId, isLoaded, isSignedIn]);

  // Esc to dismiss.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await railway.getInvoicePacketBlob(invoiceId, { asDownload: true });
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `invoice-packet-${invoiceNumber ?? invoiceId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 4000);
    } catch (err) {
      console.error('[viewer] download failed:', err);
      window.alert('Failed to download PDF.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{
          width:  'min(1000px, 96vw)',
          height: 'min(900px, 92vh)',
          background: 'var(--gc-bg)',
          boxShadow:  '0 24px 64px rgba(0,0,0,0.32)',
        }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 flex items-center gap-3 shrink-0"
          style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            Invoice {invoiceNumber ? `#${invoiceNumber}` : ''} — packet
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={handleDownload} disabled={downloading || !url}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
              style={{ background: '#1a73e8', color: '#fff' }}>
              {downloading
                ? <Loader2 size={12} className="animate-spin inline mr-1.5" />
                : <Download size={12} className="inline mr-1.5" />}
              Download
            </button>
            <button onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-[var(--gc-hover)]"
              title="Close (Esc)">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 relative" style={{ background: '#fff' }}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm" style={{ color: 'var(--gc-text-2)' }}>
              <AlertTriangle size={20} style={{ color: '#dc2626' }} />
              <div>{error}</div>
            </div>
          )}
          {url && (
            <iframe key={url}
              src={url}
              title={`Invoice ${invoiceNumber ?? ''} packet`}
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} />
          )}
        </div>
      </div>
    </div>
  );
}
