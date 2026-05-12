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

import { PDFDocument } from "pdf-lib";
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
async function appendSource(target: PDFDocument, src: SourceDoc): Promise<{ ok: boolean; reason?: string }> {
  const bytes = await downloadBytes(src);
  if (!bytes) return { ok: false, reason: "download_failed" };
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
    try {
      const image = fmt === "jpeg"
        ? await target.embedJpg(bytes)
        : await target.embedPng(bytes);
      // US Letter at 72 DPI = 612 × 792 pt. Fit image inside a small
      // margin, preserve aspect.
      const page = target.addPage([612, 792]);
      const margin = 24;
      const maxW = page.getWidth()  - margin * 2;
      const maxH = page.getHeight() - margin * 2;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const w = image.width  * scale;
      const h = image.height * scale;
      page.drawImage(image, {
        x: (page.getWidth()  - w) / 2,
        y: (page.getHeight() - h) / 2,
        width:  w,
        height: h,
      });
      return { ok: true };
    } catch (err) {
      console.warn("[invoicePacket] image embed failed:", src.path, err);
      return { ok: false, reason: "image_embed_failed" };
    }
  }
  return { ok: false, reason: `unsupported_format_${fmt}` };
}

// ─── Main builder ───────────────────────────────────────────────────────

export async function buildInvoicePacket(args: PacketArgs): Promise<PacketResult> {
  const skipped: string[] = [];

  // Render the invoice PDF in-process — same renderer the standalone
  // /pdf endpoint uses.
  const invoicePdfBytes = await renderInvoicePdf({
    snapshot:      args.invoice.snapshot,
    invoiceNumber: args.invoice.invoiceNumber,
    issuedDate:    args.issuedDate,
    dueDate:       args.dueDate,
    logoData:      args.invoice.snapshot.companyLogoUrl,
  });

  // Seed the packet with the invoice itself.
  const packet = await PDFDocument.create();
  const invoiceDoc = await PDFDocument.load(invoicePdfBytes);
  const invoicePages = await packet.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
  for (const p of invoicePages) packet.addPage(p);

  // Rate con next (if present + not a legacy data URL). The path can
  // live in either `load-documents` (current — doc-upload route) or
  // `rate-cons` (legacy parser-flow). Try the current bucket first
  // and fall back to legacy.
  if (args.rateConPath && !args.rateConPath.startsWith("data:")) {
    const tryBuckets: SourceDoc["bucket"][] = ["load-documents", "rate-cons"];
    let appended = false;
    for (const bucket of tryBuckets) {
      const r = await appendSource(packet, {
        bucket,
        path:   args.rateConPath,
        label:  "rate-con",
      });
      if (r.ok) { appended = true; break; }
    }
    if (!appended) skipped.push(`rate-con:${args.rateConPath}`);
  }

  // Selected supporting docs.
  for (const path of args.extraDocPaths) {
    const r = await appendSource(packet, {
      bucket: "load-documents",
      path,
    });
    if (!r.ok) skipped.push(path);
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
 * Look up explicit invoice_doc_ids from the loads row and translate
 * them to storage paths. Falls back to resolveDefaultPacketDocs when
 * the array is empty. This is how dispatchers customize what goes
 * into a particular invoice without retyping the docs every send.
 */
export async function resolvePacketDocsForLoad(loadId: string, orgId: string): Promise<string[]> {
  const { data: loadRow } = await supabase
    .from("loads")
    .select("invoice_doc_ids")
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  const ids = ((loadRow as { invoice_doc_ids: string[] | null } | null)?.invoice_doc_ids) ?? [];
  if (!ids.length) return resolveDefaultPacketDocs(loadId, orgId);

  const { data } = await supabase
    .from("load_documents")
    .select("id,storage_path,kind,uploaded_at")
    .eq("org_id", orgId)
    .in("id", ids);
  const byId = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; storage_path: string }>) {
    byId.set(row.id, row.storage_path);
  }
  // Preserve the user's chosen order.
  return ids.map(id => byId.get(id)).filter((v): v is string => !!v);
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
