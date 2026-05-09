'use client';

/**
 * PdfCanvas — pdfjs-dist canvas renderer with selectable text overlay.
 *
 * Loads pdfjs from jsdelivr at runtime to dodge webpack/Next.js .mjs
 * bundling bugs that break the v5 worker. Renders every page into its
 * own canvas with a transparent <span>-based text layer overlaid so
 * the browser's native selection works and copy-paste produces the
 * underlying text.
 *
 * Sizing: fit-to-container via ResizeObserver. Reusable across the
 * EventModal's docs panel, the Closeout review queue, etc.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

const PDFJS_VERSION = '5.6.205';
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfJsPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPdfJsFromCDN(): Promise<any> {
  if (pdfJsPromise) return pdfJsPromise;
  const url = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
  pdfJsPromise = new Function('u', 'return import(u)')(url);
  return pdfJsPromise!;
}

interface Props {
  /** Data URL, signed URL, blob URL, or raw base64. Empty string ⇒ spinner. */
  dataUrl: string;
  /** Optional retry hook so callers can refetch a signed URL. */
  onRetry?: () => void;
  /** Toolbar background tint. Defaults to dark. */
  toolbarStyle?: React.CSSProperties;
  /** Canvas-area background. Defaults to dark gray. */
  canvasBg?: string;
}

export default function PdfCanvas({ dataUrl, onRetry, toolbarStyle, canvasBg = '#525659' }: Props) {
  const wrapRef    = useRef<HTMLDivElement>(null);
  const boxRef     = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfRef     = useRef<any>(null);
  const naturalRef = useRef(0);

  const [containerW, setContainerW] = useState(0);
  const [ready,    setReady]    = useState(false);
  const [error,    setError]    = useState('');
  const [zoomMult, setZoomMult] = useState(1.0);
  const [retryKey, setRetryKey] = useState(0);

  // Track container width via ResizeObserver so the fit calc reacts to
  // panel resizes (e.g. user toggles the map panel side-by-side).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerW(el.clientWidth);
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Load PDF once per dataUrl
  useEffect(() => {
    let cancelled = false;
    pdfRef.current = null;
    setReady(false);
    setError('');
    if (!dataUrl) return;

    (async () => {
      const pdfjsLib = await loadPdfJsFromCDN();
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc)
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

      const src = dataUrl.startsWith('http') || dataUrl.startsWith('blob:')
        ? { url: dataUrl }
        : { data: Uint8Array.from(atob(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl), c => c.charCodeAt(0)) };
      const pdf = await pdfjsLib.getDocument(src).promise;
      if (cancelled) return;

      const page    = await pdf.getPage(1);
      const natural = page.getViewport({ scale: 1 });
      naturalRef.current = natural.width;
      pdfRef.current = pdf;
      if (!cancelled) setReady(true);
    })().catch(err => { if (!cancelled) setError(String(err)); });

    return () => { cancelled = true; };
  }, [dataUrl, retryKey]);

  // Re-render canvases on ready, zoom change, or container resize
  useEffect(() => {
    if (!ready || !pdfRef.current || !containerW || !naturalRef.current) return;
    let cancelled = false;

    (async () => {
      const box = boxRef.current;
      const pdf = pdfRef.current;
      if (!box || !pdf) return;

      while (box.firstChild) box.removeChild(box.firstChild);

      // Fit-to-container; minus 32 for padding/scrollbar
      const fitScale = Math.max(0.1, (containerW - 32) / naturalRef.current);
      const scale = fitScale * zoomMult;
      const pdfjsLib = await loadPdfJsFromCDN();

      for (let n = 1; n <= pdf.numPages; n++) {
        if (cancelled) return;
        const page     = await pdf.getPage(n);
        const viewport = page.getViewport({ scale });
        const dpr      = window.devicePixelRatio || 1;

        const wrap = document.createElement('div');
        wrap.style.position      = 'relative';
        wrap.style.width         = Math.round(viewport.width)  + 'px';
        wrap.style.height        = Math.round(viewport.height) + 'px';
        wrap.style.marginBottom  = n < pdf.numPages ? '8px' : '0';
        wrap.style.boxShadow     = '0 2px 8px rgba(0,0,0,.4)';
        box.appendChild(wrap);

        const canvas        = document.createElement('canvas');
        canvas.width        = Math.round(viewport.width  * dpr);
        canvas.height       = Math.round(viewport.height * dpr);
        canvas.style.width  = Math.round(viewport.width)  + 'px';
        canvas.style.height = Math.round(viewport.height) + 'px';
        canvas.style.display = 'block';
        wrap.appendChild(canvas);

        const ctx = canvas.getContext('2d')!;
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;

        if (cancelled) return;
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className     = 'pdfTextLayer';
        textLayerDiv.style.position = 'absolute';
        textLayerDiv.style.inset    = '0';
        textLayerDiv.style.overflow = 'hidden';
        textLayerDiv.style.opacity  = '1';
        textLayerDiv.style.lineHeight = '1';
        wrap.appendChild(textLayerDiv);
        try {
          const TextLayerCtor = (pdfjsLib as { TextLayer?: new (args: object) => { render: () => Promise<void> } }).TextLayer;
          if (TextLayerCtor) {
            const tl = new TextLayerCtor({
              textContentSource: page.streamTextContent(),
              container: textLayerDiv,
              viewport,
            });
            await tl.render();
          }
        } catch (err) {
          console.warn('[PdfCanvas] text layer failed:', err);
        }
      }
    })().catch(err => console.error('[PdfCanvas] render:', err));

    return () => { cancelled = true; };
  }, [ready, zoomMult, containerW]);

  const zoomIn  = () => { const n = ZOOM_STEPS.find(z => z > zoomMult + 0.01); if (n) setZoomMult(n); };
  const zoomOut = () => { const n = [...ZOOM_STEPS].reverse().find(z => z < zoomMult - 0.01); if (n) setZoomMult(n); };

  return (
    <div ref={wrapRef} className="flex flex-col flex-1 min-h-0">
      {/* Zoom toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5"
        style={{ background: '#3c3c3c', borderBottom: '1px solid rgba(0,0,0,.3)', ...toolbarStyle }}>
        <button onClick={zoomOut} disabled={zoomMult <= ZOOM_STEPS[0]}
          className="w-7 h-7 flex items-center justify-center rounded text-base font-medium transition-colors disabled:opacity-30"
          style={{ color: 'rgba(255,255,255,.85)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          −
        </button>
        <span className="text-xs font-mono select-none" style={{ color: 'rgba(255,255,255,.7)', minWidth: 36, textAlign: 'center' }}>
          {Math.round(zoomMult * 100)}%
        </span>
        <button onClick={zoomIn} disabled={zoomMult >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
          className="w-7 h-7 flex items-center justify-center rounded text-base font-medium transition-colors disabled:opacity-30"
          style={{ color: 'rgba(255,255,255,.85)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          +
        </button>
        <button onClick={() => setZoomMult(1.0)}
          className="text-xs px-2 py-0.5 rounded ml-1 transition-colors"
          style={{ color: 'rgba(255,255,255,.5)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.1)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          Fit
        </button>
      </div>

      {/* Canvas scroll area */}
      <div className="flex-1 overflow-auto" style={{ background: canvasBg, padding: 16 }}>
        {!ready && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm" style={{ color: 'rgba(255,255,255,.5)' }}>
            <Loader2 size={16} className="animate-spin" /> {dataUrl ? 'Rendering…' : 'Loading…'}
          </div>
        )}
        {error && (
          <div className="py-16 flex flex-col items-center gap-3">
            <div className="text-sm" style={{ color: '#fca5a5' }}>Could not render PDF</div>
            <div className="text-xs font-mono px-3 py-1 rounded" style={{ color: 'rgba(255,255,255,0.4)', background: 'rgba(0,0,0,0.3)', maxWidth: 320, wordBreak: 'break-all', textAlign: 'center' }}>{error}</div>
            <button type="button"
              onClick={() => { onRetry?.(); setRetryKey(k => k + 1); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={{ color: '#ffffff', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.25)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}>
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        )}
        <div ref={boxRef} />
      </div>
    </div>
  );
}
