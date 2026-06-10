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
  /** Diagnostic: paths that were requested but skipped (download
   *  failed, unsupported format, etc.). Empty array on full success. */
  skipped:  string[];
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
function detectFormat(bytes: Uint8Array): "pdf" | "jpeg" | "png" | "unknown" {
  if (bytes.length < 4) return "unknown";
  // %PDF-
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  // FFD8FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  // 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
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
  const skipped: string[] = [];

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
    if (!bytes) { skipped.push(src.path); continue; }
    const r = await embedPrefetched(packet, src, bytes);
    if (!r.ok) skipped.push(src.path);
  }

  // Rate con last: pick the first bucket that returned bytes.
  const rateConBuf = rateConBytes.find(b => b != null) ?? null;
  if (args.rateConPath && !args.rateConPath.startsWith("data:")) {
    if (rateConBuf) {
      const r = await embedPrefetched(packet, rateConSources[0], rateConBuf);
      if (!r.ok) skipped.push(`rate-con:${args.rateConPath}`);
    } else {
      skipped.push(`rate-con:${args.rateConPath}`);
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
  const byKind = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ storage_path: string; kind: string }>) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, row.storage_path);
  }
  // Emit in the canonical kind order so the merged packet always
  // looks the same shape across loads.
  return PACKET_DOC_KINDS_ORDER
    .map(k => byKind.get(k))
    .filter((v): v is string => !!v);
}

/**
 * Look up the dispatcher's explicit invoice-include flags from
 * load_documents.included_in_invoice and translate the picks into
 * storage paths. Falls back to resolveDefaultPacketDocs when no doc
 * on the load has been touched (every column value is NULL) so a
 * brand-new load still gets a reasonable default packet. This is how
 * dispatchers customize what goes into a particular invoice.
 *
 * Selection rule:
 *   - if ANY doc on the load has a non-null included_in_invoice value,
 *     the dispatcher has touched this load — use ONLY the explicit
 *     TRUEs. Anything they left NULL stays out.
 *   - if every doc is NULL, fall back to the newest-per-kind heuristic.
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
    .eq("org_id", orgId);
  // The generated supabase types don't carry the new column yet (it
  // lands once the user reruns the type-pull post-migration). Cast
  // through unknown so the build stays clean; runtime returns the col.
  const allDocs = ((docRows ?? []) as unknown as Array<{
    id: string; storage_path: string; kind: string; uploaded_at: string;
    included_in_invoice: boolean | null;
  }>);
  const anyTouched = allDocs.some(d => d.included_in_invoice !== null);
  if (anyTouched) {
    // Explicit picks only — order by kind preference + uploaded_at so
    // the packet shape stays predictable across loads (POD before
    // BOL before lumper etc., newest first within a kind).
    const explicit = allDocs.filter(d => d.included_in_invoice === true);
    explicit.sort((a, b) => {
      const ai = PACKET_DOC_KINDS_ORDER.indexOf(a.kind as DocumentKind);
      const bi = PACKET_DOC_KINDS_ORDER.indexOf(b.kind as DocumentKind);
      const aRank = ai < 0 ? PACKET_DOC_KINDS_ORDER.length : ai;
      const bRank = bi < 0 ? PACKET_DOC_KINDS_ORDER.length : bi;
      if (aRank !== bRank) return aRank - bRank;
      return b.uploaded_at.localeCompare(a.uploaded_at);
    });
    return explicit.map(d => d.storage_path);
  }
  // No dispatcher touch — heuristic default.
  return resolveDefaultPacketDocs(loadId, orgId);
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
 * Replace (or create) the persisted packet PDF for an invoice. Looks
 * up any existing load_documents row tied to this invoice_id, deletes
 * the old storage object + DB row, then uploads + inserts the new
 * version. Safe to call repeatedly — the latest render always wins.
 *
 * Best-effort: callers should catch errors and log rather than fail
 * the parent request. A missing archive doesn't break invoice
 * functionality (the live /packet.pdf endpoint still works).
 */
export async function persistInvoicePacket(args: {
  invoice:   Invoice;
  orgId:     string;
  /** Optional pre-built buffer to skip re-rendering. Callers like the
   *  email-send path that have a fresh packet pass it in. */
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

  // Clear out any previous archived packet for this invoice. Storage
  // object first (best-effort — Supabase tolerates missing keys), then
  // the DB row. Re-uploading to the same path also works via
  // `upsert: true` but tracking history would be harder.
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

  // Build the packet now if the caller didn't hand one in.
  let buffer = args.prebuilt;
  if (!buffer) {
    const [extraDocPaths, rateConPath] = await Promise.all([
      resolvePacketDocsForLoad(invoice.loadId, orgId),
      resolveRateConPathForLoad(invoice.loadId, orgId),
    ]);
    const fmt = (iso?: string) => iso
      ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : undefined;
    const built = await buildInvoicePacket({
      invoice,
      rateConPath,
      extraDocPaths,
      issuedDate: fmt(invoice.issuedAt),
      dueDate:    fmt(invoice.dueAt),
    });
    buffer = built.buffer;
  }

  const ts          = Date.now();
  const storagePath = `${orgId}/${eventId}/${ts}_invoice-${invoice.id}.pdf`;
  const fileName    = `Invoice-Packet-${invoice.invoiceNumber}.pdf`;

  const { error: uploadErr } = await supabase.storage
    .from(DOC_BUCKET)
    .upload(storagePath, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`);

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
      kind:         "invoice",
      invoice_id:   invoice.id,
    })
    .select("id")
    .single();
  if (insertErr || !row) {
    void supabase.storage.from(DOC_BUCKET).remove([storagePath]);
    throw new Error(`load_documents insert failed: ${insertErr?.message}`);
  }
  return { documentId: (row as { id: string }).id, storagePath };
}
