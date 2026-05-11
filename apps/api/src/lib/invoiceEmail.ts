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
  /** Pre-rendered PDF attachments. The caller is responsible for
   *  packing the right set — typically the merged invoice-packet
   *  built by invoicePacket.ts. */
  attachments: Array<{ filename: string; content: Buffer }>;
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
 * Sanitize a display name for an RFC 5322 From header. Resend accepts
 * "Name <addr@host>" syntax but chokes on bare double-quotes or angle
 * brackets inside the name. Replace problem chars with spaces.
 */
function safeDisplayName(name: string): string {
  return name.replace(/[<>"\\]/g, " ").trim();
}

export async function sendInvoiceEmail(args: SendInvoiceEmailArgs): Promise<SendInvoiceEmailResult> {
  if (!env.resendApiKey) throw new EmailNotConfiguredError();

  // From address pattern: the carrier's company name appears in the
  // display slot, the actual envelope address stays on our verified
  // domain. Replies route to the carrier's AR email via Reply-To.
  // This is the shape brokers expect — they see who they're paying
  // without us needing every org to verify a domain in Resend.
  const displayName = safeDisplayName(
    args.invoice.snapshot.companyName?.trim() || env.invoiceFromNameFallback,
  );
  const fromAddr = `${displayName} <${env.invoiceFromEmail}>`;

  // Reply-To: the carrier's AR/accounting email if they've configured
  // one. Falls back to undefined (Resend omits the header) so replies
  // just bounce back to From — not ideal but harmless.
  const replyTo  = args.invoice.snapshot.email?.trim() || undefined;

  const subject = defaultSubject(args.invoice);
  const text    = args.bodyText?.trim() || defaultBody(args.invoice);

  const { data, error } = await client().emails.send({
    from:        fromAddr,
    replyTo,
    to:          [args.to],
    cc:          args.cc?.length ? args.cc : undefined,
    bcc:         args.bccSender ? [args.bccSender] : undefined,
    subject,
    text,
    attachments: args.attachments,
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
