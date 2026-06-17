/**
 * HEIC → JPEG server-side conversion.
 *
 * Why we convert instead of rejecting: rejection (415) is a great policy
 * for keeping the DB clean going forward, but iPhone is the dominant
 * driver camera and dispatchers actively re-upload existing photos via
 * the "Manage Documents" UI. If a driver took the shot in HEIC mode
 * before we forced Most-Compatible (or before yesterday's reject layer
 * shipped), the dispatcher needs SOMETHING they can put in front of a
 * broker. Reject would just block them. Convert keeps the workflow
 * moving and the broker gets the photo.
 *
 * Library: `heic-convert` v2 — a thin wrapper around libheif-js (WASM)
 * + jpeg-js. Pure JavaScript, zero native deps, runs anywhere Node
 * does. Slower than native libheif (~1-2s for a ~3MB phone photo) but
 * the upload path can absorb that cost: it's already doing a Supabase
 * Storage round-trip + audit insert per request.
 *
 * Used by the dispatch upload route + every driver-app upload route
 * via callers in loads.ts and driver.ts.
 */

// heic-convert ships untyped CommonJS. Ambient-declare just what we
// use so callers see a typed surface without pulling a half-typed
// upstream package into our build.
// @ts-expect-error — no @types/heic-convert published; ambient-typed below.
import convertUntyped from "heic-convert";
const convert = convertUntyped as (opts: {
  buffer: ArrayBufferLike | Uint8Array;
  format: "JPEG" | "PNG";
  quality?: number;
}) => Promise<Buffer>;

export interface HeicConversionResult {
  /** Fresh ArrayBuffer-backed view so consumers stay on the default
   *  `Uint8Array<ArrayBuffer>` rather than `Uint8Array<ArrayBufferLike>`
   *  (Node 22+ TS lib distinguishes these and treats them as different
   *  types in strict mode). */
  jpegBytes: Uint8Array<ArrayBuffer>;
  /** Original byte length before conversion. Tracked so callers can log
   *  the compression ratio and detect runaway memory growth in the
   *  decoder. */
  originalBytes: number;
}

/**
 * Decode a HEIC/HEIF byte stream and re-encode as JPEG. Quality defaults
 * to 0.9 — phone POD photos are not artistic content, but JPEG <0.85
 * starts visibly degrading text on broker BOLs, license plates, etc.
 *
 * Throws on:
 *   • non-HEIC input (libheif refuses to parse)
 *   • truncated / corrupted HEIC (parse hits EOF)
 *   • out-of-memory during decode (rare; tens of MB of input)
 *
 * Callers should catch + fall back to either rejecting the upload or
 * storing the raw bytes with a flag — never silently swallow because
 * the resulting load_documents row would still be HEIC and the packet
 * builder would skip it later.
 */
export async function heicToJpeg(
  bytes: Uint8Array,
  opts: { quality?: number } = {},
): Promise<HeicConversionResult> {
  const quality = opts.quality ?? 0.9;
  // heic-convert wants a Node Buffer specifically — Uint8Array works
  // because Buffer extends Uint8Array, but we coerce explicitly so a
  // future heic-convert release that tightens the input type doesn't
  // break us silently.
  const out = await convert({
    buffer: Buffer.from(bytes),
    format: "JPEG",
    quality,
  });
  // Copy into a fresh ArrayBuffer-backed view. heic-convert returns a
  // Node Buffer whose underlying storage is a shared pool — handing
  // that back directly leaks the pool's ArrayBufferLike typing AND
  // means future writes to that pool could clobber our bytes.
  const ab    = new ArrayBuffer(out.length);
  const fresh = new Uint8Array(ab);
  fresh.set(out);
  return {
    jpegBytes:     fresh,
    originalBytes: bytes.length,
  };
}

/**
 * Replace the trailing `.heic` / `.heif` extension on a filename with
 * `.jpg`. If the filename has no recognized HEIF extension we append
 * `.jpg` so a downstream MIME-by-extension consumer doesn't mistake
 * the converted payload for raw HEIC. Case-insensitive on both sides
 * (Apple's exports often use uppercase `.HEIC`).
 */
export function rewriteHeicExtension(name: string): string {
  if (/\.(heic|heif)$/i.test(name)) return name.replace(/\.(heic|heif)$/i, ".jpg");
  if (/\.jpe?g$/i.test(name)) return name; // already legitimate
  return `${name}.jpg`;
}
