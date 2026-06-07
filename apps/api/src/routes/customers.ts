/**
 * /v1/customers — broker/customer CRUD (used for auto-matching brokers
 * extracted from rate-cons).
 */

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { DocumentBlockParam, TextBlockParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  type Customer,
  type ListCustomersResponse,
  type CreateCustomerRequest,
  type CreateCustomerResponse,
  type UpdateCustomerRequest,
  type UpdateCustomerResponse,
  type RefreshCustomerInvoicingResponse,
  type HarvestRateConFromPdfRequest,
  type HarvestRateConFromPdfResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";
import { bucketReadOrder } from "../lib/docBuckets.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const customers = new Hono<{ Variables: AuthVariables }>();

interface DbCustomerRow {
  id: string;
  name: string;
  short_name: string | null;
  aliases: string[] | null;
  mc_num: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contacts: unknown;
  notes: string | null;
  parse_hints: string | null;
  invoice_method: string | null;
  invoice_email: string | null;
  invoice_portal: string | null;
  invoice_instructions: string | null;
  billing_address: string | null;
}

import type { CustomerContact } from "@fleetcal/types";

function parseContacts(raw: unknown): CustomerContact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((c) => ({
      id:    typeof c.id === "string" ? c.id : crypto.randomUUID(),
      name:  typeof c.name  === "string" ? c.name  : undefined,
      email: typeof c.email === "string" ? c.email : undefined,
      phone: typeof c.phone === "string" ? c.phone : undefined,
    }));
}

function rowToCustomer(r: DbCustomerRow): Customer {
  const method = r.invoice_method === "email" || r.invoice_method === "portal"
    ? r.invoice_method
    : undefined;
  return {
    id:                  r.id,
    name:                r.name,
    shortName:           r.short_name           ?? undefined,
    aliases:             r.aliases              ?? [],
    mcNum:               r.mc_num               ?? undefined,
    contacts:            parseContacts(r.contacts),
    contactName:         r.contact_name         ?? undefined,
    contactEmail:        r.contact_email        ?? undefined,
    contactPhone:        r.contact_phone        ?? undefined,
    notes:               r.notes                ?? undefined,
    parseHints:          r.parse_hints          ?? undefined,
    invoiceMethod:       method,
    invoiceEmail:        r.invoice_email        ?? undefined,
    invoicePortal:       r.invoice_portal       ?? undefined,
    invoiceInstructions: r.invoice_instructions ?? undefined,
    billingAddress:      r.billing_address      ?? undefined,
  };
}

const COLS = "id,name,short_name,aliases,mc_num,contact_name,contact_email,contact_phone,contacts,notes,parse_hints,invoice_method,invoice_email,invoice_portal,invoice_instructions,billing_address";

customers.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("customers")
    .select(COLS)
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) {
    console.error("[GET /v1/customers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  // Cast through unknown — generated Supabase types lag the schema
  // until `pnpm types:gen` runs against a DB where 20260607_customers_billing_address
  // has been applied. Drop the `as unknown` once that's regenerated.
  const res: ListCustomersResponse = { customers: ((data ?? []) as unknown as DbCustomerRow[]).map(rowToCustomer) };
  return c.json(res);
});

customers.post("/", requireCapability("customers.create"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateCustomerRequest>();
  if (!body.name) {
    return c.json({ error: "validation_failed", errors: ["name required"] } satisfies ApiErrorResponse, 400);
  }
  const insert = {
    org_id:        orgId,
    name:          body.name,
    short_name:    body.shortName    ?? null,
    aliases:       body.aliases      ?? [],
    mc_num:        body.mcNum        ?? null,
    contact_name:  body.contactName  ?? null,
    contact_email: body.contactEmail ?? null,
    contact_phone: body.contactPhone ?? null,
    contacts:      body.contacts     ?? [],
    notes:                body.notes               ?? null,
    parse_hints:          body.parseHints          ?? null,
    // Default invoice_method to 'email' when the caller didn't pick
    // one. Most brokers are emailed; portal brokers are the
    // exception and the user can flip them in the broker profile.
    // Caller can still pass null explicitly to opt out.
    invoice_method:       body.invoiceMethod === undefined ? 'email' : body.invoiceMethod,
    invoice_email:        body.invoiceEmail        ?? null,
    invoice_portal:       body.invoicePortal       ?? null,
    invoice_instructions: body.invoiceInstructions ?? null,
    billing_address:      body.billingAddress      ?? null,
  };
  const { data, error } = await supabase
    .from("customers")
    .insert(insert as never)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/customers] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateCustomerResponse = { customer: rowToCustomer(data as unknown as DbCustomerRow) };
  return c.json(res, 201);
});

customers.patch("/:id", requireCapability("customers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<UpdateCustomerRequest>();

  const update: Record<string, unknown> = {};
  if ("name"         in body) update.name          = body.name;
  if ("shortName"    in body) update.short_name    = body.shortName    ?? null;
  if ("aliases"      in body) update.aliases       = body.aliases      ?? [];
  if ("mcNum"        in body) update.mc_num        = body.mcNum        ?? null;
  if ("contactName"  in body) update.contact_name  = body.contactName  ?? null;
  if ("contactEmail" in body) update.contact_email = body.contactEmail ?? null;
  if ("contactPhone" in body) update.contact_phone = body.contactPhone ?? null;
  if ("contacts"     in body) update.contacts      = body.contacts     ?? [];
  if ("notes"               in body) update.notes                = body.notes               ?? null;
  if ("parseHints"          in body) update.parse_hints          = body.parseHints          ?? null;
  if ("invoiceMethod"       in body) update.invoice_method       = body.invoiceMethod       ?? null;
  if ("invoiceEmail"        in body) update.invoice_email        = body.invoiceEmail        ?? null;
  if ("invoicePortal"       in body) update.invoice_portal       = body.invoicePortal       ?? null;
  if ("invoiceInstructions" in body) update.invoice_instructions = body.invoiceInstructions ?? null;
  if ("billingAddress"      in body) update.billing_address      = body.billingAddress      ?? null;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("customers")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/customers/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateCustomerResponse = { customer: rowToCustomer(data as unknown as DbCustomerRow) };
  return c.json(res);
});

customers.delete("/:id", requireCapability("customers.delete"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("customers")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/customers/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/customers/:id/refresh-invoicing-from-ratecon
//
// Re-runs the rate-con broker-harvest prompt against this customer's
// most recent rate confirmation, returning the four invoicing fields
// (method/email/portal/instructions) for the UI to pre-fill. The UI
// handles the actual write via PATCH /v1/customers/:id once the user
// reviews + clicks Save.
//
// The prompt below is intentionally inlined — apps/web/lib/prompt.ts
// has the canonical copy that the upload flow uses. They MUST stay in
// sync: the whole point of this endpoint is to surface the same
// invoicing extraction the post-upload AI parse already produces.
// When that prompt changes (new field, tweaked phrasing), update both.
// ─────────────────────────────────────────────────────────────────────────

const ANTHROPIC_CLIENT = new Anthropic({ apiKey: env.anthropicApiKey });
// Haiku is plenty for pass-1 invoicing harvest — small JSON, low risk
// of hallucination, and the prompt is short. Matches the model the
// rate-con upload flow uses.
const HARVEST_MODEL = "claude-haiku-4-5-20251001";

/** KEEP IN SYNC with apps/web/lib/prompt.ts → buildBrokerHarvestPrompt.
 *  The fields returned drive both the broker-profile pre-fill on
 *  upload AND this on-demand refresh, so they need to extract the
 *  same things. */
function buildBrokerHarvestPrompt(timezone: string): string {
  return `You are the first of a two-pass rate-confirmation parser. This pass extracts ONLY the broker/customer profile so the second pass can apply broker-specific rules.

Return a single JSON object with this exact shape — no markdown, no explanation. Use empty strings for fields not on the document; do not omit keys.

{
  "broker": {
    "name":                "<canonical broker / customer / shipper company name as it appears>",
    "contactName":         "<dispatcher or rep name on the rate con>",
    "contactEmail":        "<dispatcher / billing contact email>",
    "contactPhone":        "<dispatcher phone, digits + format as on the doc>",
    "invoiceMethod":       "<'email' | 'portal' | '' — how this broker wants invoices submitted. 'portal' if any online billing system is named (TriumphPay, RMIS, McLeod, MyCarrierPortal, broker's own portal, etc.). 'email' if invoices go to a specific AP/billing email. Empty string if unclear.>",
    "invoiceEmail":        "<AP / billing email when invoiceMethod is 'email', otherwise empty string>",
    "invoicePortal":       "<portal name + URL when invoiceMethod is 'portal', e.g. 'TriumphPay (https://app.triumphpay.com)'. Otherwise empty string.>",
    "invoiceInstructions": "<BROKER-WIDE billing policies only — things that apply to EVERY load from this broker, not just this one. Allowed: payment terms (net 30, quickpay rates), required documents that are always needed (BOL/POD/scale tickets/lumper receipts), factor preferences, remit-to address overrides, billing portal requirements, required line items the broker wants on every invoice. 1-3 short bulleted lines. STRICTLY EXCLUDE anything load-specific: this load's load number, PRO number, BOL number, PO number, shipment/order/confirmation number, references to 'this load' or 'this shipment', or any value that would change on the next load from the same broker. Empty string if there's nothing broker-wide to add.>",
    "billingAddress":      "<Physical mailing address where invoices should be sent — the 'Bill To' / 'Send invoices to' address. Multi-line format: 'Company Line 1\\nStreet\\nCity, ST ZIP'. Look for labels like 'Bill To', 'Remit To', 'Invoice To', 'Billing Address', 'A/P Address', or the broker's accounting/billing office. Empty string if only an email or portal is given, or if no postal address appears on the document.>"
  },
  "docType": "<rate_con | amendment | revised | other>"
}

The current timezone is ${timezone}.`;
}

function extractJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

interface HarvestBroker {
  name?:                string;
  contactName?:         string;
  contactEmail?:        string;
  contactPhone?:        string;
  invoiceMethod?:       string;
  invoiceEmail?:        string;
  invoicePortal?:       string;
  invoiceInstructions?: string;
  billingAddress?:      string;
}

/** Run the broker-harvest prompt against base64 PDF bytes. Centralized
 *  so both the by-customer refresh endpoint and the by-PDF endpoint
 *  used by the new-customer modal share a single Claude code path. */
async function runBrokerHarvest(base64: string): Promise<HarvestBroker> {
  const timezone = "Mountain Time (America/Denver)";
  const docBlock: DocumentBlockParam = {
    type:   "document",
    source: { type: "base64", media_type: "application/pdf", data: base64 },
  };
  const textBlock: TextBlockParam = { type: "text", text: buildBrokerHarvestPrompt(timezone) };
  const content: ContentBlockParam[] = [docBlock, textBlock];
  const response = await ANTHROPIC_CLIENT.messages.create({
    model:      HARVEST_MODEL,
    max_tokens: 512,
    messages:   [{ role: "user", content }],
  });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const parsed = extractJson(text) as { broker?: HarvestBroker };
  return parsed.broker ?? {};
}

/** Empty string → undefined. Lets the UI distinguish "Claude saw nothing"
 *  from "Claude said the empty string." */
function clean(s: string | undefined): string | undefined {
  const t = (s ?? "").trim();
  return t ? t : undefined;
}

/** Normalize invoiceMethod to the two valid values. Claude occasionally
 *  returns variants like "Portal" or unrelated strings when confused. */
function normalizeInvoiceMethod(raw: string | undefined): "email" | "portal" | undefined {
  const v = clean(raw)?.toLowerCase();
  return v === "email" || v === "portal" ? v : undefined;
}

// ── POST /v1/customers/harvest-from-pdf ────────────────────────────────
// Run broker-harvest on a PDF supplied in the body. Used by the
// new-customer review modal in EventModal — the customer doesn't
// exist yet so we can't go through the by-customer-id endpoint, but
// the rate con is already in the modal's hands, so just send the bytes.
customers.post("/harvest-from-pdf", requireCapability("customers.edit"), async (c) => {
  let body: HarvestRateConFromPdfRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" } satisfies ApiErrorResponse, 400);
  }
  const base64 = typeof body?.pdfBase64 === "string" ? body.pdfBase64.trim() : "";
  if (!base64) {
    return c.json({ error: "missing_pdf", detail: "pdfBase64 is required" } satisfies ApiErrorResponse, 400);
  }

  let broker: HarvestBroker;
  try {
    broker = await runBrokerHarvest(base64);
  } catch (err) {
    console.error("[POST /v1/customers/harvest-from-pdf] claude failed:", err);
    return c.json({
      error:  "parse_failed",
      detail: err instanceof Error ? err.message : "unknown",
    } satisfies ApiErrorResponse, 500);
  }

  const res: HarvestRateConFromPdfResponse = {
    parsed: {
      invoiceMethod:       normalizeInvoiceMethod(broker.invoiceMethod),
      invoiceEmail:        clean(broker.invoiceEmail),
      invoicePortal:       clean(broker.invoicePortal),
      invoiceInstructions: clean(broker.invoiceInstructions),
      contactName:         clean(broker.contactName),
      contactEmail:        clean(broker.contactEmail),
      contactPhone:        clean(broker.contactPhone),
      billingAddress:      clean(broker.billingAddress),
    },
    parsedAt: new Date().toISOString(),
  };
  return c.json(res);
});

customers.post("/:id/refresh-invoicing-from-ratecon", requireCapability("customers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const customerId = c.req.param("id");

  // Sanity-check the customer belongs to this org. No content needed
  // from the row — the 404 is the only thing that matters here.
  const { data: cust, error: custErr } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (custErr) {
    console.error("[POST /v1/customers/:id/refresh-invoicing-from-ratecon] customer read:", custErr);
    return c.json({ error: "fetch_failed", detail: custErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!cust) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  // Most recent load with a rate con. The mirror in
  // POST /v1/loads/:id/documents keeps loads.rate_con_pdf pointed at
  // the canonical storage path even for legacy load_documents rows.
  // We don't fall back to load_documents here — if the mirror is
  // missing, the load is too old to bother with for this on-demand
  // refresh. Order by created_at DESC so a recently-updated billing
  // template surfaces first.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: loads, error: loadErr } = await supabase
    .from("loads")
    .select("id, load_num, rate_con_pdf")
    .eq("org_id", orgId)
    .eq("customer_id", customerId)
    .not("rate_con_pdf", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (loadErr) {
    console.error("[POST /v1/customers/:id/refresh-invoicing-from-ratecon] load lookup:", loadErr);
    return c.json({ error: "fetch_failed", detail: loadErr.message } satisfies ApiErrorResponse, 500);
  }
  const row = (loads ?? [])[0] as { id: string; load_num: string | null; rate_con_pdf: string } | undefined;
  if (!row?.rate_con_pdf) {
    return c.json({ error: "no_rate_con", detail: "no_rate_con_on_file" } satisfies ApiErrorResponse, 404);
  }

  // Download the bytes. Rate cons live in the rate-cons bucket
  // post-Phase 3.1 split, with legacy rows still possibly in
  // load-documents — try the canonical bucket first.
  let pdfBytes: Uint8Array | null = null;
  for (const bucket of bucketReadOrder("rate_con")) {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(bucket)
      .download(row.rate_con_pdf);
    if (blob && !dlErr) {
      pdfBytes = new Uint8Array(await blob.arrayBuffer());
      break;
    }
  }
  if (!pdfBytes) {
    // The mirror points at a path neither bucket can serve. Could be a
    // legacy base64 data URL stored before the storage migration —
    // surface a friendly error rather than try to handle that edge.
    return c.json({ error: "rate_con_unreadable", detail: "could_not_download_pdf" } satisfies ApiErrorResponse, 500);
  }

  // base64 for the Anthropic document block.
  const base64 = Buffer.from(pdfBytes).toString("base64");

  let broker: HarvestBroker;
  try {
    broker = await runBrokerHarvest(base64);
  } catch (err) {
    console.error("[POST /v1/customers/:id/refresh-invoicing-from-ratecon] claude failed:", err);
    return c.json({
      error:  "parse_failed",
      detail: err instanceof Error ? err.message : "unknown",
    } satisfies ApiErrorResponse, 500);
  }

  const res: RefreshCustomerInvoicingResponse = {
    parsed: {
      invoiceMethod:       normalizeInvoiceMethod(broker.invoiceMethod),
      invoiceEmail:        clean(broker.invoiceEmail),
      invoicePortal:       clean(broker.invoicePortal),
      invoiceInstructions: clean(broker.invoiceInstructions),
      billingAddress:      clean(broker.billingAddress),
    },
    sourceLoadId:   row.id,
    sourceLoadNum:  row.load_num ?? undefined,
    parsedAt:       new Date().toISOString(),
  };
  return c.json(res);
});

export default customers;
