/**
 * Invoice email delivery via Resend.
 *
 * Encapsulates the PDF + attachments + recipient → "Message-ID" flow.
 * Resend is intentionally the only provider — easier ops than SES for
 * the volumes we're at. If we ever need to swap, this module is the
 * one place to change.
 *
 * Behavior:
 *   - Renders the invoice PDF fresh from the snapshot
 *   - Optionally bundles related load_documents (POD/BOL/etc) as
 *     additional attachments
 *   - Returns the provider message id on success; throws on failure
 */

import { Resend } from "resend";
import type { Invoice, DocumentKind } from "@fleetcal/types";
import { renderInvoicePdf } from "./invoicePdf.js";
import { env } from "./env.js";
import { supabase } from "./supabase.js";

let _resend: Resend | null = null;
function client(): Resend {
  if (_resend) return _resend;
  if (!env.resendApiKey) {
    throw new Error(
      "RESEND_API_KEY is not configured. Set it on the API service to enable invoice email delivery.",
    );
  }
  _resend = new Resend(env.resendApiKey);
  return _resend;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email delivery is not configured (missing RESEND_API_KEY).");
    this.name = "EmailNotConfiguredError";
  }
}

export interface SendInvoiceEmailArgs {
  invoice:    Invoice;
  /** Primary recipient. Required — the route validates upstream. */
  to:         string;
  cc?:        string[];
  /** Add the sender to BCC so the user has a paper trail. */
  bccSender?: string;
  /** Optional message body override. If omitted we generate a sane
   *  default referencing the invoice number, load, and broker. */
  bodyText?:  string;
  /** load_document storage paths to bundle as attachments (PODs,
   *  BOLs). Empty array = no extras; PDF stays the only attachment. */
  extraAttachmentPaths?: string[];
  /** Issued/due date display strings, same format as the on-screen
   *  renderer. Caller is responsible for formatting consistently. */
  issuedDate?: string;
  dueDate?:    string;
}

export interface SendInvoiceEmailResult {
  messageId: string;
}

/**
 * Default plain-text body. The broker AP team mostly looks at the
 * PDF; we just give them the meta they need to file it.
 */
function defaultBody(invoice: Invoice): string {
  const lines: string[] = [];
  lines.push(`Please find attached invoice #${invoice.invoiceNumber}.`);
  lines.push("");
  if (invoice.snapshot.brokerName) lines.push(`Bill to: ${invoice.snapshot.brokerName}`);
  if (invoice.snapshot.loadNumber) lines.push(`Load #${invoice.snapshot.loadNumber}`);
  if (invoice.snapshot.orderNo)    lines.push(`Order #${invoice.snapshot.orderNo}`);
  const total = invoice.total.toLocaleString("en-US", { style: "currency", currency: "USD" });
  lines.push(`Amount due: ${total}`);
  lines.push("");
  if (invoice.snapshot.remitToInstructions) {
    lines.push("Remit to:");
    lines.push(invoice.snapshot.remitToInstructions);
    lines.push("");
  }
  if (invoice.snapshot.companyName) lines.push(invoice.snapshot.companyName);
  if (invoice.snapshot.email)       lines.push(invoice.snapshot.email);
  if (invoice.snapshot.phone)       lines.push(invoice.snapshot.phone);
  return lines.join("\n");
}

/** Build a friendly subject — the broker's filename for this email. */
function defaultSubject(invoice: Invoice): string {
  const parts = [`Invoice #${invoice.invoiceNumber}`];
  if (invoice.snapshot.companyName) parts.push(`from ${invoice.snapshot.companyName}`);
  if (invoice.snapshot.loadNumber)  parts.push(`(Load #${invoice.snapshot.loadNumber})`);
  return parts.join(" ");
}

/**
 * Pull extra attachments from Supabase storage by path. Failures on
 * individual files are warnings, not fatal — we'd rather send the
 * invoice without the BOL than block on a missing file.
 */
async function loadExtraAttachments(
  paths: string[],
): Promise<Array<{ filename: string; content: Buffer }>> {
  if (!paths.length) return [];
  const out: Array<{ filename: string; content: Buffer }> = [];
  for (const path of paths) {
    try {
      const { data, error } = await supabase.storage.from("load-documents").download(path);
      if (error || !data) {
        console.warn("[invoiceEmail] attachment download failed:", path, error);
        continue;
      }
      const buf = Buffer.from(await data.arrayBuffer());
      // Use the last path segment as the filename — matches what the
      // user sees in the uploaded-docs panel.
      const filename = path.split("/").pop() ?? "document";
      out.push({ filename, content: buf });
    } catch (err) {
      console.warn("[invoiceEmail] attachment fetch threw:", path, err);
    }
  }
  return out;
}

export async function sendInvoiceEmail(args: SendInvoiceEmailArgs): Promise<SendInvoiceEmailResult> {
  if (!env.resendApiKey) throw new EmailNotConfiguredError();

  const pdf = await renderInvoicePdf({
    snapshot:      args.invoice.snapshot,
    invoiceNumber: args.invoice.invoiceNumber,
    issuedDate:    args.issuedDate,
    dueDate:       args.dueDate,
    logoData:      args.invoice.snapshot.companyLogoUrl,
  });

  const extras = await loadExtraAttachments(args.extraAttachmentPaths ?? []);

  const attachments: Array<{ filename: string; content: Buffer }> = [
    { filename: `invoice-${args.invoice.invoiceNumber}.pdf`, content: pdf },
    ...extras,
  ];

  const fromAddr = `${env.invoiceFromName} <${env.invoiceFromEmail}>`;
  const subject  = defaultSubject(args.invoice);
  const text     = args.bodyText?.trim() || defaultBody(args.invoice);

  // Resend's TS types are strict about attachment content shape;
  // accept Buffer | string. We pass Buffer directly.
  const { data, error } = await client().emails.send({
    from:        fromAddr,
    to:          [args.to],
    cc:          args.cc?.length ? args.cc : undefined,
    bcc:         args.bccSender ? [args.bccSender] : undefined,
    subject,
    text,
    attachments,
  });

  if (error || !data) {
    throw new Error(`Resend send failed: ${error?.message ?? "unknown error"}`);
  }
  return { messageId: data.id };
}

/**
 * Convenience: resolve the load's POD/BOL documents to storage paths
 * suitable for `extraAttachmentPaths`. Returns the most recent file
 * per kind (the typical "primary POD" pattern). Callers can override
 * the doc set by passing their own list of paths.
 */
export async function resolveDefaultInvoiceAttachments(loadId: string, orgId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("load_documents")
    .select("storage_path,kind,uploaded_at")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .in("kind", ["pod", "bol", "lumper", "scale"] satisfies DocumentKind[])
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.warn("[invoiceEmail] resolveDefaultAttachments failed:", error);
    return [];
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const row of (data ?? []) as Array<{ storage_path: string; kind: string }>) {
    if (seen.has(row.kind)) continue; // most recent wins per kind
    seen.add(row.kind);
    paths.push(row.storage_path);
  }
  return paths;
}
