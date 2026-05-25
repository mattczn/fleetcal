/**
 * Normalize a picked image to a guaranteed JPEG, with a soft size cap.
 *
 * Why this exists: iPhones save photos as HEIC by default. expo-image-picker
 * hands the URI back with a `.jpg` filename and an `image/jpeg` mimetype lie
 * — but the bytes on disk are still HEIC. If we upload them straight, they
 * land in storage as HEIC-bytes-tagged-JPEG. The dispatch web modal calls
 * <img> on them and the browser refuses to render (no HEIC decoder).
 *
 * Running every picked image through one ImageManipulator pass with
 * SaveFormat.JPEG forces a decode + JPEG re-encode, producing bytes that
 * are provably JPEG no matter what the source was. The cost is ~100–300 ms
 * per photo (decode + encode) which is trivial vs. the upload itself.
 *
 * Also resizes down to `maxWidth` and walks a quality ladder so the
 * result fits under `targetBytes` — most receipts/PODs end up well
 * under 500 KB even at near-lossless quality.
 *
 * Use this BEFORE building FormData for any uploaded image. The helper
 * returns a `{ uri, mimeType, fileName }` triple ready to drop into the
 * `{ uri, name, type }` shape FormData wants. The fileName is forced to
 * end in `.jpg` so storage + downstream renderers see a consistent ext.
 */

import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";

const DEFAULT_TARGET_BYTES = 3 * 1024 * 1024; // 3 MB final upload cap
const DEFAULT_MAX_WIDTH    = 2000;

async function fileSize(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && "size" in info ? (info.size ?? 0) : 0;
}

/** Drop any non-jpg/jpeg extension and append `.jpg`. */
function forceJpgExtension(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base}.jpg`;
}

export type NormalizedImage = {
  uri:      string;
  mimeType: "image/jpeg";
  fileName: string;
};

export async function normalizeImageForUpload(
  uri: string,
  fileName?: string | null,
  opts: { targetBytes?: number; maxWidth?: number } = {},
): Promise<NormalizedImage> {
  const targetBytes = opts.targetBytes ?? DEFAULT_TARGET_BYTES;
  const maxWidth    = opts.maxWidth    ?? DEFAULT_MAX_WIDTH;

  // Walk down a quality ladder, starting high so small inputs come out
  // near-lossless. Stop as soon as the output fits the byte cap.
  const qualities = [0.95, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];
  let resultUri = uri;
  for (const q of qualities) {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: maxWidth } }],
      { compress: q, format: ImageManipulator.SaveFormat.JPEG },
    );
    resultUri = out.uri;
    const size = await fileSize(resultUri);
    if (size > 0 && size <= targetBytes) break;
  }

  const baseName = fileName ?? uri.split("/").pop() ?? `photo-${Date.now()}.jpg`;
  return {
    uri:      resultUri,
    mimeType: "image/jpeg",
    fileName: forceJpgExtension(baseName),
  };
}
