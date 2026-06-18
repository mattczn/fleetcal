/**
 * Invoice packet builder.
 *
 * The "packet" is the canonical broker-facing artifact: a single
 * merged PDF containing the invoice itself, followed by the rate
 * confirmation and any selected supporting docs (POD, BOL, lumper,
 * scale, etc.). Brokers' AP teams universally prefer one file they
 * can save / forward without juggling attachments.
 *
 * Order on the broker's screen:
 *   1. Invoice            (renderInvoicePdf — always page 1)
 *   2. Rate confirmation  (loads.rate_con_pdf or kind='rate_con')
 *   3. POD / BOL / etc    (in the order they were picked)
 *
 * Image attachments (POD photos snapped on a phone) are wrapped into
 * PDF pages so the merger doesn't need a special path per file type.
 *
 * If a source file is missing or unreadable we LOG and SKIP — better
 * to send the packet without the POD than to fail the whole email.
 */

import { PDFDocument, degrees } from "pdf-lib";
import { isHeicMagic } from "./heicDetect.js";
import type { Invoice, DocumentKind } from "@fleetcal/types";
import { renderInvoicePdf } from "./invoicePdf.js";
import { supabase } from "./supabase.js";

// ─── Source descriptors ─────────────────────────────────────────────────

interface SourceDoc {
  /** Storage bucket + path. We support two buckets: `rate-cons` (legacy
   *  + current rate-con storage) and `load-documents` (everything else). */
  bucket:    "rate-cons" | "load-documents";
  path:      string;
  /** Used for logging only — the merged PDF doesn't expose filenames. */
  label?:    string;
}

interface PacketArgs {
  invoice:     Invoice;
  /** Storage path on loads.rate_con_pdf — `null` / undefined when the
   *  load has no rate con uploaded yet. Legacy base64 data URLs are
   *  skipped (we don't merge those). */
  rateConPath?: string | null;
  /** Ordered list of load_documents storage paths to append after the
   *  rate con. Caller is responsible for resolving these from
   *  loads.invoice_doc_ids or default-most-recent-by-kind. */
  extraDocPaths: string[];
  /** Issued / due display strings — same format as the on-screen renderer. */
  issuedDate?: string;
  dueDate?:    string;
}

export interface PacketResult {
  buffer:   Buffer;
  /** Diagnostic: requested sources that didn't make it into the merged
   *  packet (download failed, unsupported format, embedder threw…),
   *  each with its failure reason so the caller can surface it to the
   *  dispatcher BEFORE the email actually goes out. Empty on full
   *  success. */
  skipped:  Array<{ path: string; reason: string }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function downloadBytes(src: SourceDoc): Promise<Uint8Array | null> {
  try {
    const { data, error } = await supabase.storage.from(src.bucket).download(src.path);
    if (error || !data) {
      console.warn("[invoicePacket] download failed:", src.bucket, src.path, error);
      return null;
    }
    return new Uint8Array(await data.arrayBuffer());
  } catch (err) {
    console.warn("[invoicePacket] download threw:", src.bucket, src.path, err);
    return null;
  }
}

/**
 * Read the EXIF Orientation tag (0x0112) out of a JPEG byte stream.
 * Returns 1 (no rotation) when:
 *   • the file isn't a JPEG,
 *   • there's no APP1/EXIF segment,
 *   • the segment is malformed,
 *   • or the orientation value is missing / out of range / a mirrored
 *     variant (2/4/5/7 — those need a flip too, which pdf-lib can't
 *     do, so we fall back to no rotation rather than show a mirrored
 *     POD).
 *
 * Why this exists: pdf-lib's embedJpg ignores EXIF entirely. Phones
 * almost always save raw landscape pixels and set an EXIF orientation
 * tag (6 or 8) telling viewers to rotate to portrait. Without honoring
 * that, every portrait phone photo would land sideways in the packet.
 *
 * Spec ref: TIFF 6.0 / EXIF 2.32 IFD0 tag 0x0112.
 *
 *   1 = top-left (normal)        — 0°
 *   2 = top-right                — mirror horizontal
 *   3 = bottom-right             — 180°
 *   4 = bottom-left              — mirror vertical
 *   5 = left-top                 — mirror horizontal + 90° CCW
 *   6 = right-top                — 90° CW
 *   7 = right-bottom             — mirror horizontal + 90° CW
 *   8 = left-bottom              — 90° CCW
 */
function readJpegOrientation(bytes: Uint8Array): 1 | 3 | 6 | 8 {
  if (bytes.length < 12) return 1;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1; // not JPEG
  // Walk JPEG segments looking for APP1 (FFE1) that starts with "Exif\0\0".
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) return 1; // every segment starts with 0xFF
    const marker = bytes[off + 1];
    // SOS (start-of-scan) means we've reached image data; no more EXIF.
    if (marker === 0xda) return 1;
    const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
    if (segLen < 2) return 1;
    // APP1 with EXIF identifier "Exif\0\0"
    if (
      marker === 0xe1 &&
      off + 4 + 6 <= bytes.length &&
      bytes[off + 4] === 0x45 && bytes[off + 5] === 0x78 &&
      bytes[off + 6] === 0x69 && bytes[off + 7] === 0x66 &&
      bytes[off + 8] === 0x00 && bytes[off + 9] === 0x00
    ) {
      const tiff = off + 10;
      if (tiff + 8 > bytes.length) return 1;
      const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
      const be = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
      if (!le && !be) return 1;
      const read16 = (p: number) => le
        ? (bytes[p] | (bytes[p + 1] << 8))
        : ((bytes[p] << 8) | bytes[p + 1]);
      const read32 = (p: number) => le
        ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24))
        : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]);
      if (read16(tiff + 2) !== 0x002a) return 1; // TIFF magic
      const ifd0 = tiff + read32(tiff + 4);
      if (ifd0 + 2 > bytes.length) return 1;
      const entries = read16(ifd0);
      for (let i = 0; i < entries; i++) {
        const e = ifd0 + 2 + i * 12;
        if (e + 12 > bytes.length) return 1;
        if (read16(e) === 0x0112) {
          // Type SHORT (3) with count 1 → value lives in the first 2 bytes
          // of the value-or-offset field. Just read it as a SHORT.
          const v = read16(e + 8);
          if (v === 1 || v === 3 || v === 6 || v === 8) return v;
          return 1; // mirrored variants 2/4/5/7 — give up on rotation
        }
      }
      return 1;
    }
    off += 2 + segLen;
  }
  return 1;
}

/**
 * Sniff the file kind from the magic bytes. We can't trust the path
 * extension — some uploads come in as `.jpeg.pdf` etc. PDF starts
 * with `%PDF-`, JPEG with FFD8FF, PNG with 89 50 4E 47.
 */
function detectFormat(bytes: Uint8Array): "pdf" | "jpeg" | "png" | "heic" | "unknown" {
  if (bytes.length < 4) return "unknown";
  // %PDF-
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  // FFD8FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  // 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  // HEIC / HEIF — ISO BMFF `ftyp` box at offset 4. pdf-lib can't embed
  // these; we surface a dedicated reason so the send-time error tells
  // the dispatcher "this is HEIC, re-export as JPG" instead of vague
  // "unsupported_format".
  if (isHeicMagic(bytes)) return "heic";
  return "unknown";
}

/**
 * Append the contents of `src` (any of pdf/jpeg/png) onto `target`.
 * PDFs are page-copied; images are placed onto a fresh letter page
 * fit to the page width. Unknown formats are skipped.
 */
/**
 * Embed pre-fetched source bytes into the target PDF. Same logic as
 * appendSource() except the network call is hoisted out, so callers
 * can fire all downloads in parallel before doing the serial embeds.
 */
async function embedPrefetched(
  target: PDFDocument,
  src:    SourceDoc,
  bytes:  Uint8Array,
): Promise<{ ok: boolean; reason?: string }> {
  const fmt = detectFormat(bytes);
  if (fmt === "pdf") {
    try {
      const donor = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await target.copyPages(donor, donor.getPageIndices());
      for (const p of pages) target.addPage(p);
      return { ok: true };
    } catch (err) {
      console.warn("[invoicePacket] PDF copyPages failed:", src.path, err);
      return { ok: false, reason: "pdf_parse_failed" };
    }
  }
  if (fmt === "jpeg" || fmt === "png") {
    return embedImagePrefetched(target, src, bytes, fmt);
  }
  if (fmt === "heic") {
    // pdf-lib has no HEIC path. Dispatcher needs an explicit hint — the
    // 422 the send endpoint returns surfaces this reason verbatim so
    // they see "POD.jpg is HEIC, re-export as JPG" in the confirm
    // dialog instead of a generic "unsupported_format" string.
    console.warn("[invoicePacket] HEIC source can't be embedded:", src.path);
    return { ok: false, reason: "heic_unsupported_re_export_as_jpg" };
  }
  console.warn("[invoicePacket] unsupported format:", src.path, fmt);
  return { ok: false, reason: "unsupported_format" };
}

async function embedImagePrefetched(
  target: PDFDocument,
  src:    SourceDoc,
  bytes:  Uint8Array,
  fmt:    "jpeg" | "png",
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const image = fmt === "jpeg"
      ? await target.embedJpg(bytes)
      : await target.embedPng(bytes);

    // EXIF orientation only applies to JPEG; PNG has no equivalent
    // metadata flag (chunks for orientation are nonstandard and
    // unsupported by phone cameras).
    const orient = fmt === "jpeg" ? readJpegOrientation(bytes) : 1;

    // Intended display dimensions AFTER honoring EXIF rotation.
    // Orientations 6 and 8 need a 90° spin, swapping the visible
    // width and height. 1 and 3 keep the raw aspect.
    const intendedW = (orient === 6 || orient === 8) ? image.height : image.width;
    const intendedH = (orient === 6 || orient === 8) ? image.width  : image.height;

    // Pick the page orientation that matches the intended display
    // aspect. A landscape POD on a portrait page renders tiny with
    // 50% wasted whitespace; a landscape page lets it fill the sheet
    // at full readable size. US Letter = 612 × 792 pt @ 72 DPI.
    const portrait = intendedH >= intendedW;
    const pageW = portrait ? 612 : 792;
    const pageH = portrait ? 792 : 612;
    const page = target.addPage([pageW, pageH]);

    const margin = 24;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const scale = Math.min(maxW / intendedW, maxH / intendedH, 1);

    // Compute (x, y, width, height, rotate) for page.drawImage.
    // `width` and `height` are in the IMAGE's pre-rotation coord
    // system. `rotate` is applied around the (x, y) pivot, which is
    // the image's bottom-left in PDF's Y-up space. For non-zero
    // rotations we shift (x, y) so the rotated bounding box lands
    // centered on the page. Derivations live in the comments next
    // to each branch.
    const w = image.width  * scale; // pre-rotation width in image coords
    const h = image.height * scale;
    let x: number, y: number, rot: number;
    switch (orient) {
      case 6: {
        // 90° CW. Rotated corners (relative to pivot):
        //   x ∈ [0, h], y ∈ [-w, 0]
        // Centering on page: x = (pageW - h) / 2, y = (pageH + w) / 2.
        rot = -90;
        x = (pageW - h) / 2;
        y = (pageH + w) / 2;
        break;
      }
      case 8: {
        // 90° CCW. Rotated corners: x ∈ [-h, 0], y ∈ [0, w].
        // Centering: x = (pageW + h) / 2, y = (pageH - w) / 2.
        rot = 90;
        x = (pageW + h) / 2;
        y = (pageH - w) / 2;
        break;
      }
      case 3: {
        // 180°. Rotated corners: x ∈ [-w, 0], y ∈ [-h, 0].
        // Centering: x = (pageW + w) / 2, y = (pageH + h) / 2.
        rot = 180;
        x = (pageW + w) / 2;
        y = (pageH + h) / 2;
        break;
      }
      default: {
        // 0°. Standard bottom-left placement.
        rot = 0;
        x = (pageW - w) / 2;
        y = (pageH - h) / 2;
      }
    }

    page.drawImage(image, {
      x, y,
      width:  w,
      height: h,
      rotate: degrees(rot),
    });
    return { ok: true };
  } catch (err) {
    console.warn("[invoicePacket] image embed failed:", src.path, err);
    return { ok: false, reason: "image_embed_failed" };
  }
}

/**
 * Legacy entry: download + embed in one call. Kept for any callers that
 * don't benefit from parallel pre-fetch (right now there are none in
 * buildInvoicePacket, but the function is exported-internal so we keep
 * the simple shape available for future single-doc append paths).
 */
async function appendSource(target: PDFDocument, src: SourceDoc): Promise<{ ok: boolean; reason?: string }> {
  const bytes = await downloadBytes(src);
  if (!bytes) return { ok: false, reason: "download_failed" };
  return embedPrefetched(target, src, bytes);
}

// ─── Main builder ───────────────────────────────────────────────────────

export async function buildInvoicePacket(args: PacketArgs): Promise<PacketResult> {
  const skipped: Array<{ path: string; reason: string }> = [];

  // PARALLELIZE the slow stuff: the @react-pdf/renderer invocation +
  // every Supabase Storage download happens at the same time. The
  // serial-document mutations (PDFDocument.load, copyPages, embedJpg)
  // still run sequentially after — those are CPU-bound and operate on
  // a single mutable PDFDocument, so doing them concurrently would
  // either race or require N extra documents to merge later (not worth
  // it; the wins come from network parallelism).
  //
  // Speedup on a 4-attachment invoice: ~2.5s → ~1.2s based on
  // rule-of-thumb numbers (render 1s + 4 downloads 300ms each
  // sequentially) vs (max(render 1s, 4 parallel downloads ~400ms) = 1s).

  // Resolve which buckets to try for the rate-con (legacy + current).
  const rateConSources: SourceDoc[] = (() => {
    if (!args.rateConPath || args.rateConPath.startsWith("data:")) return [];
    return (["rate-cons", "load-documents"] as SourceDoc["bucket"][]).map(bucket => ({
      bucket,
      path:  args.rateConPath!,
      label: "rate-con",
    }));
  })();
  const extraSources: SourceDoc[] = args.extraDocPaths.map(path => ({
    bucket: "load-documents",
    path,
  }));

  // Fire everything in parallel.
  const [invoicePdfBytes, extraFetched, rateConBytes] = await Promise.all([
    renderInvoicePdf({
      snapshot:      args.invoice.snapshot,
      invoiceNumber: args.invoice.invoiceNumber,
      issuedDate:    args.issuedDate,
      dueDate:       args.dueDate,
      logoData:      args.invoice.snapshot.companyLogoUrl,
    }),
    Promise.all(extraSources.map(s => downloadBytes(s))),
    // Try each rate-con bucket in parallel; take the first non-null.
    Promise.all(rateConSources.map(s => downloadBytes(s))),
  ]);

  // Packet order: invoice → POD / BOL / lumper / scale / etc.
  // (the "proof" docs brokers actually need to approve payment) →
  // rate confirmation last. Brokers want to verify delivery before
  // matching the invoice to the original rate agreement, so the
  // proof docs sit closer to the invoice and the rate con anchors
  // the back of the packet as the contract reference.

  // Seed the packet with the invoice itself.
  const packet = await PDFDocument.create();
  const invoiceDoc = await PDFDocument.load(invoicePdfBytes);
  const invoicePages = await packet.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
  for (const p of invoicePages) packet.addPage(p);

  // Selected supporting docs (POD/BOL/lumper/scale/receipt/driver_sheet,
  // in the kind order resolveDefaultPacketDocs already emits). Bytes
  // pre-fetched above; just embed sequentially.
  for (let i = 0; i < extraSources.length; i++) {
    const bytes = extraFetched[i];
    const src   = extraSources[i];
    if (!bytes) { skipped.push({ path: src.path, reason: "download_failed" }); continue; }
    const r = await embedPrefetched(packet, src, bytes);
    if (!r.ok) skipped.push({ path: src.path, reason: r.reason ?? "embed_failed" });
  }

  // Rate con last: pick the first bucket that returned bytes.
  const rateConBuf = rateConBytes.find(b => b != null) ?? null;
  if (args.rateConPath && !args.rateConPath.startsWith("data:")) {
    if (rateConBuf) {
      const r = await embedPrefetched(packet, rateConSources[0], rateConBuf);
      if (!r.ok) skipped.push({ path: `rate-con:${args.rateConPath}`, reason: r.reason ?? "embed_failed" });
    } else {
      skipped.push({ path: `rate-con:${args.rateConPath}`, reason: "download_failed" });
    }
  }

  const out = await packet.save();
  return {
    buffer:  Buffer.from(out),
    skipped,
  };
}

/**
 * Resolve the default supporting-doc set for a load. Order matches
 * the order brokers typically expect: POD first (proof of delivery),
 * then BOL, lumper receipts, scale tickets. Most recent per kind
 * wins so we don't include stale duplicates.
 *
 * If the load has an explicit invoiceDocIds array set, it overrides
 * this default — the caller passes those paths directly instead.
 */
const PACKET_DOC_KINDS_ORDER: DocumentKind[] = ["pod", "bol", "lumper", "scale", "receipt", "driver_sheet"];

export async function resolveDefaultPacketDocs(loadId: string, orgId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("load_documents")
    .select("storage_path,kind,uploaded_at")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .in("kind", PACKET_DOC_KINDS_ORDER)
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.warn("[invoicePacket] resolveDefault failed:", error);
    return [];
  }
  const rows = (data ?? []) as Array<{ storage_path: string; kind: string; uploaded_at: string }>;

  // PODs: if a doc is on the load tagged kind='pod', it belongs in the
  // packet. Brokers want as much proof of delivery as we can hand them;
  // there's no upside to filtering by a time window. Previous versions
  // gated PODs to "uploaded within 24h of delivery" to match a defensive
  // UI heuristic — but the heuristic dropped real PODs uploaded at pickup
  // time or in batches days before delivery, and the dispatcher had no
  // good way to override the default.
  //
  // Every other kind (BOL, lumper, scale, receipt, driver_sheet) is
  // a singleton in practice — newest-per-kind keeps the packet small
  // and never picks two competing copies of the same kind.
  const pickedPodPaths: string[] = [];
  const newestByOtherKind = new Map<string, string>();
  for (const r of rows) {
    if (r.kind === "pod") {
      pickedPodPaths.push(r.storage_path);
    } else {
      if (!newestByOtherKind.has(r.kind)) {
        newestByOtherKind.set(r.kind, r.storage_path);
      }
    }
  }

  // Emit in canonical kind order so the merged packet shape stays
  // predictable across loads. PODs come first per PACKET_DOC_KINDS_ORDER.
  const out: string[] = [];
  for (const kind of PACKET_DOC_KINDS_ORDER) {
    if (kind === "pod") {
      // PODs ordered by upload time DESC (matches the query order),
      // so the newest POD lands first within the POD block. Brokers
      // typically read top-down; freshest photo lands at the top.
      out.push(...pickedPodPaths);
    } else {
      const p = newestByOtherKind.get(kind);
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * Resolve the dispatcher-selected docs for a load's invoice packet.
 *
 * Selection rule (per-doc, kind-aware):
 *
 *   PODs:
 *     - included_in_invoice = true   → INCLUDE
 *     - included_in_invoice = false  → EXCLUDE
 *     - included_in_invoice = null   → INCLUDE  (default: every POD belongs)
 *
 *   Other kinds (BOL, lumper, scale, receipt, driver_sheet):
 *     - included_in_invoice = true   → INCLUDE  (explicit pick wins)
 *     - included_in_invoice = false  → EXCLUDE
 *     - included_in_invoice = null   → INCLUDE only if newest of its kind
 *                                       (singleton fallback — multiple
 *                                       drafts of the same BOL would
 *                                       otherwise both attach)
 *
 * Why per-kind: PODs are commonly multiple-per-load (one photo per
 * pallet, one per damage angle), and brokers want them all. Other
 * kinds are singletons in practice; we don't want to attach an old
 * BOL alongside a corrected one just because both rows exist.
 *
 * The previous version had an `anyTouched` global flag that flipped
 * the WHOLE load into "explicit picks only" mode the moment ANY doc
 * got ticked. That meant clicking two POD pills excluded the other
 * four PODs on the load — the silent breakage that lost half of
 * Curzon's 13092 PODs on 2026-06-17.
 *
 * Replaced the legacy loads.invoice_doc_ids array reader on
 * 2026-06-07 (see migration 20260607_load_documents_included_in_invoice
 * and ReviewQueue / accounting page Save flows).
 */
export async function resolvePacketDocsForLoad(loadId: string, orgId: string): Promise<string[]> {
  const { data: docRows } = await supabase
    .from("load_documents")
    .select("id,storage_path,kind,uploaded_at,included_in_invoice")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .in("kind", PACKET_DOC_KINDS_ORDER)
    .order("uploaded_at", { ascending: false });
  // The generated supabase types don't carry the new column yet (it
  // lands once the user reruns the type-pull post-migration). Cast
  // through unknown so the build stays clean; runtime returns the col.
  const allDocs = ((docRows ?? []) as unknown as Array<{
    id: string; storage_path: string; kind: string; uploaded_at: string;
    included_in_invoice: boolean | null;
  }>);

  // PODs: include unless explicit FALSE. Preserves uploaded_at-DESC
  // ordering from the query so the broker sees the newest photo on top.
  const podPaths = allDocs
    .filter(d => d.kind === "pod" && d.included_in_invoice !== false)
    .map(d => d.storage_path);

  // Non-PODs: per-kind picker.
  //   - First doc of the kind with TRUE wins (most recent explicit pick).
  //   - Otherwise the newest doc of the kind that isn't explicitly FALSE
  //     becomes the singleton default.
  const nonPodPathsByKind = new Map<string, string>();
  for (const kind of PACKET_DOC_KINDS_ORDER) {
    if (kind === "pod") continue;
    const ofKind = allDocs.filter(d => d.kind === kind);
    const explicitTrue = ofKind.find(d => d.included_in_invoice === true);
    if (explicitTrue) {
      nonPodPathsByKind.set(kind, explicitTrue.storage_path);
      continue;
    }
    const newestUntouched = ofKind.find(d => d.included_in_invoice !== false);
    if (newestUntouched) {
      nonPodPathsByKind.set(kind, newestUntouched.storage_path);
    }
  }

  // Emit in canonical kind order so the merged packet shape stays
  // predictable across loads. PODs come first per PACKET_DOC_KINDS_ORDER.
  const out: string[] = [];
  for (const kind of PACKET_DOC_KINDS_ORDER) {
    if (kind === "pod") {
      out.push(...podPaths);
    } else {
      const p = nonPodPathsByKind.get(kind);
      if (p) out.push(p);
    }
  }
  return out;
}


/**
 * Fetch the load's rate-con storage path for packet assembly. Returns
 * null for legacy base64 data URLs (we don't merge those) and for
 * loads without a rate con on file.
 */
export async function resolveRateConPathForLoad(loadId: string, orgId: string): Promise<string | null> {
  const { data } = await supabase
    .from("loads")
    .select("rate_con_pdf")
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  const val = (data as { rate_con_pdf: string | null } | null)?.rate_con_pdf ?? null;
  if (!val || val.startsWith("data:")) return null;
  return val;
}

// ─── Persistence ────────────────────────────────────────────────────────
//
// Each generated invoice gets a permanent copy of its merged packet
// PDF stored as a `load_documents` row (kind='invoice'). This makes
// the artifact appear in the load's docs panel alongside POD/BOL,
// and gives accounting an immutable "what we sent" trail when an
// invoice gets voided or regenerated.
//
// We DON'T store the standalone invoice PDF — the packet is the
// broker-facing artifact, and the standalone version can always be
// re-rendered from the snapshot via /v1/invoices/:id/pdf if needed.

const DOC_BUCKET = "load-documents";

/**
 * Replace (or create) the persisted PDFs for an invoice. Two artifacts
 * are saved on every call:
 *
 *   kind='invoice'         → bare invoice PDF only (single page, no
 *                             supporting docs). Used when the dispatcher
 *                             wants to send "just the invoice" without
 *                             rate-con/POD.
 *   kind='invoice_packet'  → full merged broker-facing packet (invoice
 *                             + rate-con + POD/BOL/etc). The default
 *                             email attachment.
 *
 * Both are wiped + re-uploaded together so they stay in sync — a stale
 * packet shouldn't outlive an updated invoice. The return value
 * references the packet row to preserve the original API shape
 * (callers that care about the bare invoice can re-query by kind).
 *
 * Best-effort: callers should catch errors and log rather than fail
 * the parent request. A missing archive doesn't break invoice
 * functionality (the live /packet.pdf endpoint still works).
 */
export async function persistInvoicePacket(args: {
  invoice:   Invoice;
  orgId:     string;
  /** Optional pre-built PACKET buffer to skip re-rendering the merged
   *  packet. Callers like the email-send path that have a fresh
   *  packet pass it in. The bare invoice is always re-rendered (it's
   *  cheap — no attachments to download). */
  prebuilt?: Buffer;
}): Promise<{ documentId: string; storagePath: string }> {
  const { invoice, orgId } = args;

  // Need an event_id for the load_documents row (legacy NOT NULL).
  // Prefer the pickup leg so per-event scoped queries land naturally
  // on the start-of-the-load event.
  const { data: legsRaw, error: legsErr } = await supabase
    .from("events")
    .select("id,relay_role")
    .eq("load_id", invoice.loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (legsErr) throw new Error(`event lookup failed: ${legsErr.message}`);
  const legs = (legsRaw ?? []) as Array<{ id: string; relay_role: string | null }>;
  const eventId =
       legs.find(e => e.relay_role === "pickup")?.id
    ?? legs[0]?.id;
  if (!eventId) throw new Error("no active event for load");

  // Clear out ANY previous archived artifact for this invoice (both
  // the packet AND the bare invoice). Storage objects first (best-
  // effort — Supabase tolerates missing keys), then the DB rows.
  const { data: existing } = await supabase
    .from("load_documents")
    .select("id,storage_path")
    .eq("invoice_id", invoice.id)
    .eq("org_id", orgId);
  const existingRows = (existing ?? []) as Array<{ id: string; storage_path: string }>;
  if (existingRows.length) {
    await supabase.storage.from(DOC_BUCKET).remove(existingRows.map(r => r.storage_path)).catch(() => undefined);
    await supabase
      .from("load_documents")
      .delete()
      .in("id", existingRows.map(r => r.id))
      .eq("org_id", orgId);
  }

  const fmt = (iso?: string) => iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;
  const issuedDate = fmt(invoice.issuedAt);
  const dueDate    = fmt(invoice.dueAt);

  // Render the BARE invoice PDF. Cheap — no Storage downloads — but
  // happens regardless because we need it for the kind='invoice' row.
  const bareInvoiceBytes = await renderInvoicePdf({
    snapshot:      invoice.snapshot,
    invoiceNumber: invoice.invoiceNumber,
    issuedDate,
    dueDate,
    logoData:      invoice.snapshot.companyLogoUrl,
  });

  // Build the full packet. If the caller already has one (email-send
  // path), reuse it.
  let packetBuffer = args.prebuilt;
  if (!packetBuffer) {
    const [extraDocPaths, rateConPath] = await Promise.all([
      resolvePacketDocsForLoad(invoice.loadId, orgId),
      resolveRateConPathForLoad(invoice.loadId, orgId),
    ]);
    const built = await buildInvoicePacket({
      invoice,
      rateConPath,
      extraDocPaths,
      issuedDate,
      dueDate,
    });
    packetBuffer = built.buffer;
  }

  const ts = Date.now();

  // Upload + insert both. Order: packet first so the legacy return
  // value (documentId, storagePath) keeps pointing at the packet row,
  // matching the pre-split API shape.
  const packetUpload = await uploadArtifact(
    eventId,
    `${orgId}/${eventId}/${ts}_invoice-packet-${invoice.id}.pdf`,
    `Invoice-Packet-${invoice.invoiceNumber}.pdf`,
    "invoice_packet",
    Buffer.from(packetBuffer),
    invoice,
    orgId,
  );

  // Bare invoice gets a slightly different storage path so the two
  // can coexist under the same event.
  await uploadArtifact(
    eventId,
    `${orgId}/${eventId}/${ts}_invoice-only-${invoice.id}.pdf`,
    `Invoice-${invoice.invoiceNumber}.pdf`,
    "invoice",
    Buffer.from(bareInvoiceBytes),
    invoice,
    orgId,
  );

  return packetUpload;
}

/** Upload a single PDF + insert its load_documents row. Used by both
 *  the packet and the bare-invoice paths so the storage/DB plumbing
 *  lives in one place. */
async function uploadArtifact(
  eventId:     string,
  storagePath: string,
  fileName:    string,
  kind:        "invoice" | "invoice_packet",
  buffer:      Buffer,
  invoice:     Invoice,
  orgId:       string,
): Promise<{ documentId: string; storagePath: string }> {
  const { error: uploadErr } = await supabase.storage
    .from(DOC_BUCKET)
    .upload(storagePath, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadErr) throw new Error(`storage upload failed (${kind}): ${uploadErr.message}`);

  const { data: row, error: insertErr } = await supabase
    .from("load_documents")
    .insert({
      event_id:     eventId,
      load_id:      invoice.loadId,
      org_id:       orgId,
      storage_path: storagePath,
      file_name:    fileName,
      mime_type:    "application/pdf",
      size_bytes:   buffer.length,
      kind,
      invoice_id:   invoice.id,
    })
    .select("id")
    .single();
  if (insertErr || !row) {
    void supabase.storage.from(DOC_BUCKET).remove([storagePath]);
    throw new Error(`load_documents insert failed (${kind}): ${insertErr?.message}`);
  }
  return { documentId: (row as { id: string }).id, storagePath };
}
