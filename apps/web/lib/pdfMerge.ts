/**
 * pdfMerge — combine a heterogeneous file list into a single PDF blob.
 *
 * Drivers / dispatchers often have a stack of PDFs and phone photos
 * (JPEG, sometimes HEIC on iPhones) for one load — POD page 1, POD
 * page 2, lumper receipt, scale ticket, etc. This utility takes that
 * mixed set and returns one merged PDF so the rest of the system
 * (upload endpoint, broker invoice packets) deals with a single file.
 *
 * Implementation:
 *   - pdf-lib creates the merged doc + drives page composition
 *   - PDFs are copied page-for-page via copyPages
 *   - JPEG / PNG are embedded directly
 *   - HEIC is converted to JPEG via the existing heic2any dep (lazy
 *     imported so non-HEIC merges don't pay its bundle cost)
 *   - WebP / GIF / unknown image MIME → rasterized through a canvas
 *     to JPEG so pdf-lib can embed it
 *
 * Pages are sized to the natural pixel dimensions of the embedded
 * image. PDF readers scale them appropriately on view; for very large
 * phone photos the bytes are kept compact by skipping any re-encode
 * step beyond what HEIC / canvas-rasterized formats already do.
 */

import { PDFDocument } from 'pdf-lib';

export interface MergeOptions {
  /** Fires before each input file is processed. Use for UI progress. */
  onProgress?: (currentIndex: number, total: number, fileName: string) => void;
}

export async function mergeFilesToPdf(
  files: File[],
  options: MergeOptions = {},
): Promise<Blob> {
  if (files.length === 0) {
    throw new Error('mergeFilesToPdf: no files supplied');
  }
  const merged = await PDFDocument.create();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    options.onProgress?.(i, files.length, f.name);

    if (isPdf(f)) {
      const srcBytes = new Uint8Array(await f.arrayBuffer());
      const srcDoc   = await PDFDocument.load(srcBytes);
      const copied   = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
      copied.forEach(page => merged.addPage(page));
      continue;
    }

    // Anything else gets treated as an image. Normalize to JPEG or
    // PNG bytes (the two formats pdf-lib can embed natively), then
    // drop into a page sized to the source dimensions.
    const { bytes, mime } = await normalizeToEmbeddableImage(f);
    const img = mime === 'image/png'
      ? await merged.embedPng(bytes)
      : await merged.embedJpg(bytes);
    const page = merged.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }

  const out = await merged.save();
  // pdf-lib returns Uint8Array<ArrayBufferLike>, but the DOM Blob
  // constructor types want ArrayBuffer. The runtime is always a
  // standard ArrayBuffer-backed Uint8Array — this cast just calms TS.
  return new Blob([out as unknown as ArrayBuffer], { type: 'application/pdf' });
}

function isPdf(f: File): boolean {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}
function isHeic(f: File): boolean {
  const t = (f.type ?? '').toLowerCase();
  return t === 'image/heic' || t === 'image/heif' || /\.(heic|heif)$/i.test(f.name);
}
function isJpeg(f: File): boolean {
  return f.type === 'image/jpeg' || f.type === 'image/jpg' || /\.(jpe?g)$/i.test(f.name);
}
function isPng(f: File): boolean {
  return f.type === 'image/png' || /\.png$/i.test(f.name);
}

/** Returns raw image bytes pdf-lib can embed (JPEG or PNG). HEIC is
 *  routed through heic2any; everything else weird (WebP / GIF / BMP)
 *  goes through a canvas → JPEG roundtrip so we don't need to teach
 *  pdf-lib about more formats. */
async function normalizeToEmbeddableImage(f: File): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' }> {
  if (isHeic(f)) {
    const mod = await import('heic2any');
    const heic2any = (mod as unknown as { default: (opts: { blob: Blob; toType: string; quality?: number }) => Promise<Blob | Blob[]> }).default;
    const out = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.92 });
    const blob = Array.isArray(out) ? out[0] : out;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
  }
  if (isJpeg(f)) {
    return { bytes: new Uint8Array(await f.arrayBuffer()), mime: 'image/jpeg' };
  }
  if (isPng(f)) {
    return { bytes: new Uint8Array(await f.arrayBuffer()), mime: 'image/png' };
  }
  // WebP / GIF / BMP / unknown image — rasterize via canvas to JPEG.
  // pdf-lib doesn't speak those formats directly, but the browser
  // can decode them into a canvas which we re-export as JPEG bytes.
  const blobUrl = URL.createObjectURL(f);
  try {
    const img = await loadImage(blobUrl);
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth  || 1;
    canvas.height = img.naturalHeight || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(img, 0, 0);
    const jpegBlob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')), 'image/jpeg', 0.92),
    );
    return { bytes: new Uint8Array(await jpegBlob.arrayBuffer()), mime: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}
