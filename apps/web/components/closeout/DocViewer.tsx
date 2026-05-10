'use client';

/**
 * DocViewer — multi-format document viewer for the closeout flow.
 *
 * The previous setup routed everything through PdfCanvas, which broke
 * with "Invalid PDF structure" when a driver uploaded a JPG/HEIC. This
 * dispatches by mime type / file extension:
 *
 *   PDF                     → PdfCanvas (zoom + selectable text)
 *   image/jpeg|png|webp|gif → <img>
 *   image/heic|heif         → heic2any → JPEG blob → <img>
 *   anything else           → "Download to view" fallback
 *
 * heic2any is loaded via dynamic import the first time a HEIC is shown
 * so non-HEIC users don't pay its bundle cost.
 */

import { useEffect, useState } from 'react';
import { Loader2, Download, FileText } from 'lucide-react';
import PdfCanvas from '@/components/pdf/PdfCanvas';

interface Props {
  /** Signed URL or data URL. Empty string ⇒ spinner. */
  url: string;
  /** MIME type as reported by the upload — preferred over extension. */
  mimeType?: string;
  /** Original file name — used as a fallback type signal + download label. */
  fileName?: string;
  /** Hook callback so the parent can refetch a signed URL on retry. */
  onRetry?: () => void;
}

const PDF_EXT   = /\.pdf$/i;
const IMG_EXT   = /\.(jpe?g|png|webp|gif|bmp|svg)$/i;
const HEIC_EXT  = /\.(heic|heif)$/i;

function classify(mime?: string, name?: string): 'pdf' | 'img' | 'heic' | 'other' {
  const m = (mime ?? '').toLowerCase();
  const n = name ?? '';
  if (m === 'application/pdf' || PDF_EXT.test(n))                       return 'pdf';
  if (m === 'image/heic' || m === 'image/heif' || HEIC_EXT.test(n))     return 'heic';
  if (m.startsWith('image/') || IMG_EXT.test(n))                        return 'img';
  return 'other';
}

export default function DocViewer({ url, mimeType, fileName, onRetry }: Props) {
  const kind = classify(mimeType, fileName);

  if (!url) return <CenterStatus icon={<Loader2 size={16} className="animate-spin" />} text="Loading…" />;
  if (kind === 'pdf') return <PdfCanvas dataUrl={url} onRetry={onRetry} />;
  if (kind === 'img') return <ImageViewer url={url} fileName={fileName} />;
  if (kind === 'heic') return <HeicViewer url={url} fileName={fileName} />;
  return <UnsupportedFallback url={url} fileName={fileName} />;
}

function ImageViewer({ url, fileName }: { url: string; fileName?: string }) {
  return (
    <div className="flex-1 overflow-auto flex items-center justify-center" style={{ background: '#525659', padding: 16 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={fileName ?? 'document'}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', boxShadow: '0 2px 8px rgba(0,0,0,.4)' }}
      />
    </div>
  );
}

function HeicViewer({ url, fileName }: { url: string; fileName?: string }) {
  // Convert via heic2any once on mount per URL change. The conversion
  // is heavy (~hundreds of ms on a phone-shot HEIC) so we render a
  // dedicated spinner state.
  const [convertedUrl, setConvertedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;
    setConvertedUrl(null);
    setError(null);

    (async () => {
      // Pull the source bytes — signed URLs work, data URLs work too.
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const sourceBlob = await res.blob();

      // Lazy-load heic2any — keeps it out of the main bundle for the
      // 99% of viewers who never look at a HEIC.
      const mod = await import('heic2any');
      const heic2any = (mod as unknown as { default: (opts: { blob: Blob; toType: string; quality?: number }) => Promise<Blob | Blob[]> }).default;
      const out = await heic2any({ blob: sourceBlob, toType: 'image/jpeg', quality: 0.9 });
      const jpegBlob = Array.isArray(out) ? out[0] : out;
      if (cancelled) return;
      blobUrl = URL.createObjectURL(jpegBlob);
      setConvertedUrl(blobUrl);
    })().catch(err => {
      if (cancelled) return;
      console.error('[DocViewer] HEIC conversion failed:', err);
      setError(String(err));
    });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);

  if (error) {
    return <UnsupportedFallback url={url} fileName={fileName} reason={`HEIC conversion failed: ${error}`} />;
  }
  if (!convertedUrl) {
    return <CenterStatus icon={<Loader2 size={16} className="animate-spin" />} text="Converting HEIC…" />;
  }
  return <ImageViewer url={convertedUrl} fileName={fileName} />;
}

function UnsupportedFallback({ url, fileName, reason }: { url: string; fileName?: string; reason?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 text-center"
      style={{ background: '#525659', color: 'rgba(255,255,255,0.7)' }}>
      <FileText size={28} style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 8 }} />
      <div className="text-sm font-semibold mb-1" style={{ color: '#fff' }}>
        Preview unavailable
      </div>
      <div className="text-xs mb-4" style={{ color: 'rgba(255,255,255,0.5)' }}>
        {reason ?? 'This file type can\'t be previewed in the browser.'}
      </div>
      <a href={url} target="_blank" rel="noopener noreferrer" download={fileName}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
        style={{ color: '#ffffff', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.25)' }}>
        <Download size={12} /> Download to view
      </a>
    </div>
  );
}

function CenterStatus({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex-1 flex items-center justify-center gap-2 text-sm" style={{ background: '#525659', color: 'rgba(255,255,255,.6)' }}>
      {icon} {text}
    </div>
  );
}
