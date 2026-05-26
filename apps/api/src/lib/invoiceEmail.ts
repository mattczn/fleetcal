/**
 * Invoice email delivery via Resend.
 *
 * Encapsulates the PDF + attachments + recipient → "Message-ID" flow.
 * Resend is intentionally the only provider — easier ops than SES for
 * the volumes we're at. If we ever need to swap, this module is the
 * one place to change.
 *
 * Accepts ONE OR MORE invoices in a single email (the batch-send path
 * already groups by broker and sends one email per broker with N
 * packets attached). The subject + body templating handles both cases
 * via placeholder substitution — single-invoice sends just render the
 * same template with a one-element list.
 */

import { Resend } from "resend";
import type { Invoice, DocumentKind, InvoiceSettings } from "@fleetcal/types";
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
  /** One or more invoices for this email. Single sends pass a
   *  one-element array; batch sends pass the full broker group. */
  invoices:   Invoice[];
  /** Primary recipient. Required — the route validates upstream. */
  to:         string;
  cc?:        string[];
  /** Add the sender to BCC so the user has a paper trail. */
  bccSender?: string;
  /** Optional message body override. If omitted we render the org's
   *  configured template, falling back to the built-in default. */
  bodyText?:  string;
  /** Optional subject override. Same fallback chain as bodyText. */
  subject?:   string;
  /** Per-org template config. Pulled fresh by the caller (cheap
   *  org_settings lookup). Optional — we fall back to defaults if
   *  unset. */
  invoiceSettings?: InvoiceSettings;
  /** Pre-rendered PDF attachments. The caller is responsible for
   *  packing the right set — typically the merged invoice-packet
   *  built by invoicePacket.ts. */
  attachments: Array<{ filename: string; content: Buffer }>;
}

export interface SendInvoiceEmailResult {
  messageId: string;
}

// ── Default templates ──────────────────────────────────────────────────
//
// Kept as constants (not interpolated to settings) so a user who hasn't
// touched their template still gets the canonical experience. Changing
// these defaults flows through to every org without a custom template.

const DEFAULT_SUBJECT_TEMPLATE =
  "Invoice #{{invoiceNumber}}, Load {{loadNumber}}";

const DEFAULT_BODY_TEMPLATE = [
  "Please find the attached invoice(s):",
  "",
  "{{invoiceList}}",
  "",
  "Bill to: {{brokerName}}",
  "Total: {{total}}",
  "",
  "{{remitTo}}",
  "",
  "{{companyName}}",
  "{{email}}",
  "{{phone}}",
].join("\n");

const moneyFmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Joiner for list-style placeholders. Caps at MAX_LIST_INLINE entries
 * with a "+ N more" suffix so a 12-invoice batch doesn't produce a
 * 400-char subject line. Body-rendered lists use the full set.
 */
const MAX_LIST_INLINE = 4;
function joinList(items: Array<string | undefined | null>): string {
  const cleaned = items.map((x) => (x ?? "").toString().trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length <= MAX_LIST_INLINE) return cleaned.join(", ");
  const head = cleaned.slice(0, MAX_LIST_INLINE).join(", ");
  const more = cleaned.length - MAX_LIST_INLINE;
  return `${head} + ${more} more`;
}

/**
 * Build the placeholder substitution map for a batch of invoices.
 * All invoices in `invoices` share the same broker recipient (per the
 * batch-send grouping), so broker-level fields are read off the first
 * invoice's snapshot.
 */
function buildSubstitutions(invoices: Invoice[]): Record<string, string> {
  const first = invoices[0];
  const totalSum = invoices.reduce((s, i) => s + (i.total ?? 0), 0);

  const invoiceNumbers      = joinList(invoices.map((i) => i.invoiceNumber));
  // {{loadNumber}} renders the BROKER's load number (load.load_num →
  // snapshot.orderNo at draft time). Falls back to our internal load
  // id when the broker number wasn't set.
  const loadNumbers         = joinList(invoices.map((i) => i.snapshot.orderNo || i.snapshot.loadNumber));
  const internalLoadNumbers = joinList(invoices.map((i) => i.snapshot.loadNumber));

  // {{invoiceList}} — one row per invoice with its number / load / amount.
  // Used inside the body template; the subject typically uses the
  // collapsed {{invoiceNumber}} / {{loadNumber}} placeholders instead.
  const list = invoices.map((inv) => {
    const load = inv.snapshot.orderNo || inv.snapshot.loadNumber || "—";
    return `• Invoice #${inv.invoiceNumber}, Load ${load} — ${moneyFmt(inv.total ?? 0)}`;
  }).join("\n");

  return {
    invoiceNumber:       invoiceNumbers,
    loadNumber:          loadNumbers,
    internalLoadNumber:  internalLoadNumbers,
    brokerName:          first.snapshot.brokerName || "",
    companyName:         first.snapshot.companyName || "",
    total:               moneyFmt(totalSum),
    count:               String(invoices.length),
    invoiceList:         list,
    remitTo:             first.snapshot.remitToInstructions || "",
    email:               first.snapshot.email || "",
    phone:               first.snapshot.phone || "",
  };
}

/**
 * Substitute {{key}} placeholders in `template` from `subs`. Unknown
 * keys are left intact — a typo'd placeholder is more recognizable
 * than a silent empty string and easier to debug. Then collapse any
 * runs of blank lines down to a max of two so optional placeholders
 * that came out empty don't leave huge gaps in the rendered email.
 */
function applyTemplate(template: string, subs: Record<string, string>): string {
  let out = template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in subs ? subs[key] : match;
  });
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function renderInvoiceEmailSubject(
  invoices: Invoice[],
  settings?: InvoiceSettings,
): string {
  const template = settings?.invoiceEmailSubjectTemplate?.trim() || DEFAULT_SUBJECT_TEMPLATE;
  return applyTemplate(template, buildSubstitutions(invoices));
}

export function renderInvoiceEmailBody(
  invoices: Invoice[],
  settings?: InvoiceSettings,
): string {
  const template = settings?.invoiceEmailBodyTemplate?.trim() || DEFAULT_BODY_TEMPLATE;
  return applyTemplate(template, buildSubstitutions(invoices));
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
  if (args.invoices.length === 0) throw new Error("sendInvoiceEmail: invoices array is empty");

  const first = args.invoices[0];

  // From address pattern: the carrier's company name appears in the
  // display slot, the actual envelope address stays on our verified
  // domain. Replies route to the carrier's AR email via Reply-To.
  // This is the shape brokers expect — they see who they're paying
  // without us needing every org to verify a domain in Resend.
  const displayName = safeDisplayName(
    first.snapshot.companyName?.trim() || env.invoiceFromNameFallback,
  );
  const fromAddr = `${displayName} <${env.invoiceFromEmail}>`;

  // Reply-To: the carrier's AR/accounting email if they've configured
  // one. Falls back to undefined (Resend omits the header) so replies
  // just bounce back to From — not ideal but harmless.
  const replyTo  = first.snapshot.email?.trim() || undefined;

  const subject = args.subject?.trim() || renderInvoiceEmailSubject(args.invoices, args.invoiceSettings);
  const text    = args.bodyText?.trim() || renderInvoiceEmailBody(args.invoices, args.invoiceSettings);

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
 * Build a deduped CC list from any mix of user-provided + org-default
 * sources. Each source may be:
 *   - a string (single email, or comma/semicolon-separated list)
 *   - a string[] (already split)
 *   - undefined / null (skipped)
 *
 * Dedup is case-insensitive on the address. Order is preserved
 * across sources so user-provided addresses appear before the org's
 * auto-CC (matters when an email client truncates very long header
 * lines — the user's intentional pick stays visible).
 */
export function mergeCcList(...sources: Array<string | string[] | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    if (!src) continue;
    const items = Array.isArray(src) ? src : src.split(/[,;]/);
    for (const raw of items) {
      const email = (raw ?? "").trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
  }
  return out;
}

/**
 * Load the org's invoice_settings so the send routes can pass it into
 * sendInvoiceEmail for templating + read ccEmail in one query. Returns
 * undefined when no row exists.
 */
export async function loadOrgInvoiceSettings(orgId: string): Promise<InvoiceSettings | undefined> {
  const { data, error } = await supabase
    .from("org_settings")
    .select("invoice_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.warn("[invoiceEmail] loadOrgInvoiceSettings failed:", error);
    return undefined;
  }
  const settings = (data as { invoice_settings: InvoiceSettings | null } | null)?.invoice_settings;
  return settings ?? undefined;
}

/**
 * Convenience wrapper around loadOrgInvoiceSettings that returns just
 * the auto-CC string. Preserved for callers that only need that field
 * to avoid widening their imports.
 */
export async function loadOrgAutoCc(orgId: string): Promise<string | undefined> {
  const settings = await loadOrgInvoiceSettings(orgId);
  const cc = settings?.ccEmail?.trim();
  return cc || undefined;
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
