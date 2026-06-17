/**
 * HEIC detection — by mime type and by magic bytes.
 *
 * Why this exists: an iPhone takes a photo, saves it as `.heic`, and the
 * driver / dispatcher uploads it through our doc-upload endpoint thinking
 * "JPG, .jpg, same thing." Browsers correctly stamp `image/heic` on the
 * multipart blob but our upload route was accepting it anyway. Downstream,
 * pdf-lib has no HEIC support, so the packet builder silently skips
 * the photo — broker gets the invoice with no POD. Costs real money.
 *
 * Two layers of defense:
 *   1. `isHeicMime` — fast string check against the client-declared mime.
 *      Catches the common "iPhone uploaded straight" path.
 *   2. `isHeicMagic` — sniff the first 12 bytes for the ISO BMFF `ftyp`
 *      box. Catches uploads that lied about their mime type (renamed
 *      .heic → .jpg with no real conversion, browser zero'd `file.type`,
 *      etc.). This is the authoritative check.
 *
 * Spec ref: ISO/IEC 14496-12 (ISO BMFF) + ISO/IEC 23008-12 (HEIF).
 * `ftyp` major brand for HEIF images: heic, heix, mif1, msf1, heim,
 * heis, hevm, hevs (HEVC sequences). hevc/hevx are technically video
 * but iOS occasionally tags single-frame stills with these too.
 */

const HEIC_BRANDS: ReadonlySet<string> = new Set([
  "heic", "heix",      // HEIF still image, HEVC encoded
  "mif1", "msf1",      // HEIF Image Format generic
  "heim", "heis",      // HEIF image collection
  "hevc", "hevx",      // HEVC sequence (iOS sometimes uses these)
  "hevm", "hevs",      // HEVC sequence layered
]);

export function isHeicMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return m === "image/heic" || m === "image/heif"
      || m === "image/heic-sequence" || m === "image/heif-sequence";
}

export function isHeicMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // Bytes 4..7 are the box type, which for HEIF/HEIC files is always 'ftyp'.
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return false;
  }
  // Bytes 8..11 are the major brand. Decode as ASCII and match against the
  // HEIF brand list. Anything else (jpeg, mp4, etc.) returns false here.
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return HEIC_BRANDS.has(brand);
}

/** Convenience: returns true when EITHER the client-declared mime OR the
 *  magic bytes indicate HEIC. Use at the upload boundary so a renamed
 *  file (e.g. `.jpg` extension with HEIC content) is still caught. */
export function isHeic(bytes: Uint8Array, mime: string | null | undefined): boolean {
  return isHeicMime(mime) || isHeicMagic(bytes);
}
