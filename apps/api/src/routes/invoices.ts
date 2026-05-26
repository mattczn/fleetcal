/**
 * /v1/invoices — invoice lifecycle for a load.
 *
 * Flow:
 *   POST   /v1/invoices                 — generate from a load
 *   GET    /v1/invoices                 — list (filters: status, loadId, brokerId, from, to)
 *   GET    /v1/invoices/:id             — single
 *   PATCH  /v1/invoices/:id             — edit a draft
 *   POST   /v1/invoices/:id/send        — flip draft → sent
 *   POST   /v1/invoices/:id/mark-paid   — flip sent  → paid
 *   POST   /v1/invoices/:id/void        — flip any   → void
 *
 * Snapshot: every invoice carries a frozen InvoiceSnapshot in jsonb so
 * the rendered document stays stable even if org_settings or the load
 * change later. Generation reads load + events + stops + customer +
 * org_settings and assembles the snapshot in one shot.
 *
 * Numbering: defaults to the load's internal_load_id with an optional
 * prefix from org_settings.invoice_settings.invoice_number_prefix.
 * Callers may override via CreateInvoiceRequest.invoiceNumber.
 *
 * Side effects: a successful generation also flips loads.billing_status
 * to 'invoiced' so the closeout queue moves the load forward.
 */

import { Hono } from "hono";
import {
  type CreateInvoiceRequest,
  type CreateInvoiceResponse,
  type ListInvoicesResponse,
  type GetInvoiceResponse,
  type UpdateInvoiceRequest,
  type UpdateInvoiceResponse,
  type SendInvoiceRequest,
  type SendInvoiceResponse,
  type GenerateInvoicePacketResponse,
  type BatchSendInvoicesRequest,
  type BatchSendInvoicesResponse,
  type BatchGenerateInvoicesRequest,
  type BatchGenerateInvoicesResponse,
  type MarkInvoicePaidRequest,
  type MarkInvoicePaidResponse,
  type VoidInvoiceRequest,
  type VoidInvoiceResponse,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceSnapshot,
  type InvoiceSnapshotStop,
  type InvoiceStatus,
  INVOICE_STATUSES,
  type InvoiceSettings,
  type Accessorial,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { getOrgIdentity } from "../lib/clerk.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

const invoices = new Hono<{ Variables: AuthVariables }>();

// All invoice endpoints — listing, reading PDFs, sending, marking
// paid, voiding — require accounting.access. Dispatcher and
// Maintenance never see this section. The send/batch-send endpoints
// additionally need accounting.send_invoice (currently the same
// allow-list but kept separate so we can add a "view only" role
// later without rewriting every route).
// Module gate first so a no-accounting plan returns module_disabled
// instead of missing_capability.
invoices.use("*", requireModule("accounting"), requireCapability("accounting.access"));

// ─────────────────────────────────────────────────────────────────────────
// Row shape (snake_case from Postgres)
// ─────────────────────────────────────────────────────────────────────────

interface InvoiceRow {
  id:              string;
  org_id:          string;
  load_id:         string;
  customer_id:     string | null;
  invoice_number:  string;
  status:          InvoiceStatus;
  total:           number;
  issued_at:       string;
  due_at:          string | null;
  snapshot:        InvoiceSnapshot;
  sent_at:         string | null;
  sent_to:         string | null;
  sent_method:     "email" | "portal" | "manual" | null;
  paid_at:         string | null;
  paid_amount:     number | null;
  paid_method:     "ach" | "check" | "wire" | "other" | null;
  paid_note:       string | null;
  void_reason:     string | null;
  created_at:      string;
  updated_at:      string;
}

const INVOICE_COLS =
  "id,org_id,load_id,customer_id,invoice_number,status,total,issued_at,due_at," +
  "snapshot,sent_at,sent_to,sent_method,paid_at,paid_amount,paid_method,paid_note," +
  "void_reason,created_at,updated_at";

function rowToInvoice(r: InvoiceRow): Invoice {
  return {
    id:            r.id,
    orgId:         r.org_id,
    loadId:        r.load_id,
    customerId:    r.customer_id   ?? undefined,
    invoiceNumber: r.invoice_number,
    status:        r.status,
    total:         r.total,
    issuedAt:      r.issued_at,
    dueAt:         r.due_at        ?? undefined,
    snapshot:      r.snapshot,
    sentAt:        r.sent_at       ?? undefined,
    sentTo:        r.sent_to       ?? undefined,
    sentMethod:    r.sent_method   ?? undefined,
    paidAt:        r.paid_at       ?? undefined,
    paidAmount:    r.paid_amount   ?? undefined,
    paidMethod:    r.paid_method   ?? undefined,
    paidNote:      r.paid_note     ?? undefined,
    voidReason:    r.void_reason   ?? undefined,
    createdAt:     r.created_at,
    updatedAt:     r.updated_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoContext = any;
function badRequest(c: AnyHonoContext, errors: string[]) {
  const res: ApiErrorResponse = { error: "validation_failed", errors };
  return c.json(res, 400);
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot generation — reads the load + dependencies and assembles the
// frozen view of the invoice. Pure(ish) function; the only side effect is
// the supabase reads.
// ─────────────────────────────────────────────────────────────────────────

interface LoadRowForInvoice {
  id:               string;
  internal_load_id: number;
  load_num:         string | null;
  broker:           string | null;
  customer_id:      string | null;
  load_price:       number | null;
  accessorials:     Accessorial[] | null;
}

interface EventRowForInvoice {
  id:    string;
  start: string;
  end:   string;
}

interface StopRowForInvoice {
  event_id:      string;
  sequence:      number;
  type:          string;
  facility_name: string | null;
  city:          string | null;
  state:         string | null;
}

interface CustomerRowForInvoice {
  id:            string;
  name:          string;
  invoice_email: string | null;
}

/** Map a stop row's `type` to the display label rendered on the invoice.
 *  Relay-type stops are internal-only handoff markers and are filtered
 *  out before this is called — they should never reach the broker. */
function stopKindLabel(t: string): InvoiceSnapshotStop["kind"] {
  switch (t) {
    case "pickup":     return "Pickup";
    case "delivery":   return "Delivery";
    case "drop_hook":  return "Drop";
    default:           return "Stop";
  }
}

/** "MMM D, YYYY" — matches the format the Settings preview uses. */
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "YYYY-MM-DD" extracted from an event.start (which is naive local time). */
function isoDay(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  // event.start is "YYYY-MM-DDTHH:mm" — first 10 chars is the date.
  const date = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return date;
}

function isoDayToDisplay(d?: string): string | undefined {
  if (!d) return undefined;
  // Parse as a local date (no TZ surprises) and format.
  const [y, m, day] = d.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !day) return d;
  return fmtDate(new Date(y, m - 1, day));
}

async function buildSnapshot(
  orgId: string,
  loadId: string,
  overrides: Partial<CreateInvoiceRequest>,
): Promise<
  | { snapshot: InvoiceSnapshot; total: number; load: LoadRowForInvoice; invoiceSettings: InvoiceSettings; dueAt: string | null }
  | { error: { status: number; body: ApiErrorResponse } }
> {
  // 1. Org settings — invoice_settings drives company identity, terms, etc.
  const { data: orgSettingsRow } = await supabase
    .from("org_settings")
    .select("invoice_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  const invoiceSettings: InvoiceSettings =
    ((orgSettingsRow as { invoice_settings: InvoiceSettings | null } | null)?.invoice_settings) ?? {};

  // 2. Load row
  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .select("id,internal_load_id,load_num,broker,customer_id,load_price,accessorials")
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (loadErr) {
    return { error: { status: 500, body: { error: "fetch_failed", detail: loadErr.message } } };
  }
  if (!loadRow) {
    return { error: { status: 404, body: { error: "not_found", detail: "load not found" } } };
  }
  const load = loadRow as unknown as LoadRowForInvoice;

  // 3. Events (sorted by start) + stops.
  //
  // For relay loads, the split-relay flow duplicates the FULL merged stop
  // list onto BOTH legs (so each leg can render the complete route with
  // the other side's stops greyed out). Naively pulling stops for all
  // events would put every stop on the invoice twice. To avoid that we
  // only read stops from ONE event — the pickup leg, falling back to the
  // first event by start. Non-relay loads have just one event, so this
  // is a no-op for them.
  const { data: evRowsRaw, error: evErr } = await supabase
    .from("events")
    .select("id,start,end,relay_role")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (evErr) {
    return { error: { status: 500, body: { error: "fetch_failed", detail: evErr.message } } };
  }
  const eventRows = (evRowsRaw ?? []) as unknown as Array<EventRowForInvoice & { relay_role: string | null }>;

  const stopsSourceEventId =
       eventRows.find((e) => e.relay_role === "pickup")?.id
    ?? eventRows[0]?.id
    ?? null;

  let stopRows: StopRowForInvoice[] = [];
  if (stopsSourceEventId) {
    const { data: stRows } = await supabase
      .from("stops")
      .select("event_id,sequence,type,facility_name,city,state")
      .eq("event_id", stopsSourceEventId)
      .order("sequence", { ascending: true });
    stopRows = ((stRows ?? []) as unknown as StopRowForInvoice[]);
  }

  // 4. Customer (broker bill-to) — optional.
  let customer: CustomerRowForInvoice | null = null;
  if (load.customer_id) {
    const { data: custRow } = await supabase
      .from("customers")
      .select("id,name,invoice_email")
      .eq("id", load.customer_id)
      .eq("org_id", orgId)
      .maybeSingle();
    customer = (custRow as CustomerRowForInvoice | null) ?? null;
  }

  // 5. Stops → display rows. Number pickups and deliveries separately so
  // each kind is seq 1, 2, 3 in its own series (matches Alvys style).
  //
  // Relay-type stops are excluded — they're internal handoff markers
  // and have no meaning to the broker. The pickup→delivery view that
  // ends up on the invoice should look the same whether or not the load
  // was dispatched as a relay internally.
  const stopsForSnapshot: InvoiceSnapshotStop[] = [];
  const seqByKind = new Map<string, number>();
  for (const s of stopRows) {
    if (s.type === "relay") continue;
    const kind = stopKindLabel(s.type);
    const seq  = (seqByKind.get(kind) ?? 0) + 1;
    seqByKind.set(kind, seq);
    const cityState = [s.city ?? "", s.state ?? ""].filter(Boolean).join(" ").toUpperCase();
    stopsForSnapshot.push({
      kind,
      seq,
      facility:  (s.facility_name ?? "").toUpperCase(),
      cityState,
      refs:      "",
    });
  }

  // 6. Line items. If caller supplied them, use as-is. Otherwise derive
  // from load_price (linehaul) + billable accessorials.
  let lineItems: InvoiceLineItem[];
  if (overrides.lineItems && overrides.lineItems.length > 0) {
    lineItems = overrides.lineItems;
  } else {
    const items: InvoiceLineItem[] = [];
    if (load.load_price && load.load_price > 0) {
      items.push({
        description: "Linehaul",
        rate:        load.load_price,
        units:       1,
        uom:         "Flat",
        amount:      load.load_price,
      });
    }
    for (const a of load.accessorials ?? []) {
      if (a.billable === false) continue;
      if (!a.amount || a.amount <= 0) continue;
      items.push({
        description: a.description?.trim() || a.category.replace(/_/g, " "),
        rate:        a.amount,
        units:       1,
        uom:         "Each",
        amount:      a.amount,
      });
    }
    lineItems = items;
  }

  const totalCharges = lineItems.reduce((sum, li) => sum + (li.amount ?? 0), 0);

  // 7. Dates: order/pickup/delivered come from the first/pickup event start
  // and the last/delivery event end. For a single-event load both fall on
  // the same event.
  const firstStart = eventRows[0]?.start;
  const lastEnd    = eventRows[eventRows.length - 1]?.end;

  const issuedAt = new Date();
  const termsDays = invoiceSettings.defaultPaymentTermsDays;
  let dueAt: string | null = null;
  if (overrides.dueAt) {
    dueAt = new Date(overrides.dueAt).toISOString();
  } else if (Number.isFinite(termsDays) && termsDays! > 0) {
    const due = new Date(issuedAt);
    due.setDate(due.getDate() + (termsDays as number));
    dueAt = due.toISOString();
  }

  // Freeze the Clerk org identity (name fallback + logo URL) into the
  // snapshot so the invoice doesn't change if the org renames or
  // re-uploads its logo later. imageUrl from Clerk is a public CDN URL
  // and is safe to use directly in the PDF renderer.
  const orgIdentity = await getOrgIdentity(orgId);

  const snapshot: InvoiceSnapshot = {
    companyName:    invoiceSettings.companyName ?? orgIdentity?.name ?? "",
    companyLogoUrl: orgIdentity?.imageUrl,
    addressLine1:   invoiceSettings.addressLine1,
    addressLine2:   invoiceSettings.addressLine2,
    city:           invoiceSettings.city,
    state:          invoiceSettings.state,
    zip:            invoiceSettings.zip,
    phone:          invoiceSettings.phone,
    email:          invoiceSettings.email,
    mcNumber:       invoiceSettings.mcNumber,
    dotNumber:      invoiceSettings.dotNumber,
    ein:            invoiceSettings.ein,
    remitToInstructions: overrides.remitToInstructions ?? invoiceSettings.remitToInstructions,
    invoiceFooterNotes:  overrides.invoiceFooterNotes  ?? invoiceSettings.invoiceFooterNotes,

    brokerName:        customer?.name ?? load.broker ?? "",
    // We don't yet have structured broker addresses on customers — leave
    // these blank until Phase 3 broker batch flow adds them.
    brokerAddrLine1:   undefined,
    brokerAddrLine2:   undefined,

    orderNo:        load.load_num ?? undefined,
    poNumber:       undefined,
    // orderDate intentionally left undefined — pickupDate already
    // anchors the order timeline and the broker doesn't need both.
    orderDate:      undefined,
    pickupDate:     isoDayToDisplay(isoDay(firstStart)),
    deliveredDate:  isoDayToDisplay(isoDay(lastEnd)),
    loadNumber:     String(load.internal_load_id),

    stops:          stopsForSnapshot,
    lineItems,
    totalCharges,
    balanceDue:     totalCharges,
  };

  return { snapshot, total: totalCharges, load, invoiceSettings, dueAt };
}

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices — generate from a load
// ─────────────────────────────────────────────────────────────────────────

invoices.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateInvoiceRequest>();

  if (!body?.loadId) return badRequest(c, ["loadId required"]);

  const result = await buildSnapshot(orgId, body.loadId, body);
  if ("error" in result) {
    return c.json(result.error.body, result.error.status as 400 | 404 | 500);
  }
  const { snapshot, total, load, invoiceSettings, dueAt } = result;

  // Resolve invoice number. Caller override wins; otherwise derive from
  // internal_load_id + configured prefix.
  const prefix = invoiceSettings.invoiceNumberPrefix ?? "";
  const invoiceNumber = body.invoiceNumber?.trim()
    || `${prefix}${load.internal_load_id}`;

  const insertRow = {
    org_id:          orgId,
    load_id:         load.id,
    customer_id:     load.customer_id,
    invoice_number:  invoiceNumber,
    status:          "draft" as InvoiceStatus,
    total,
    issued_at:       new Date().toISOString(),
    due_at:          dueAt,
    snapshot,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("invoices")
    .insert(insertRow as any)
    .select(INVOICE_COLS)
    .single();

  if (error) {
    // 23505 = unique_violation — most likely the open-invoice-per-load
    // partial index or the per-org invoice_number uniqueness.
    if ((error as { code?: string }).code === "23505") {
      return c.json(
        { error: "invoice_exists", detail: "an active invoice already exists for this load or invoice number" } satisfies ApiErrorResponse,
        409,
      );
    }
    console.error("[POST /v1/invoices] insert failed:", error);
    return c.json({ error: "insert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  // Mirror onto loads.billing_status so the closeout queue advances.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from("loads").update({ billing_status: "invoiced" } as any)
    .eq("id", load.id).eq("org_id", orgId);

  const newInvoice = rowToInvoice(data as unknown as InvoiceRow);

  // Persist the merged packet PDF as a load_documents row so it
  // appears in the load's docs panel immediately. Best-effort —
  // failures here log but don't fail the invoice creation.
  try {
    const { persistInvoicePacket } = await import("../lib/invoicePacket.js");
    await persistInvoicePacket({ invoice: newInvoice, orgId });
  } catch (err) {
    console.warn("[POST /v1/invoices] packet persistence failed:", err);
  }

  const res: CreateInvoiceResponse = { invoice: newInvoice };
  return c.json(res, 201);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/invoices — list
// ─────────────────────────────────────────────────────────────────────────

invoices.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const statusParam = url.searchParams.get("status");
  const loadId   = url.searchParams.get("loadId");
  const brokerId = url.searchParams.get("brokerId");
  const from     = url.searchParams.get("from");
  const to       = url.searchParams.get("to");

  let statusList: InvoiceStatus[] | undefined;
  if (statusParam) {
    const parts = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = parts.filter((s) => !INVOICE_STATUSES.includes(s as InvoiceStatus));
    if (invalid.length) return badRequest(c, [`unknown status values: ${invalid.join(",")}`]);
    statusList = parts as InvoiceStatus[];
  }

  let q = supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("org_id", orgId)
    .order("issued_at", { ascending: false });
  if (statusList) q = q.in("status", statusList);
  if (loadId)     q = q.eq("load_id", loadId);
  if (brokerId)   q = q.eq("customer_id", brokerId);
  if (from)       q = q.gte("issued_at", from);
  if (to)         q = q.lte("issued_at", to);

  const { data, error } = await q;
  if (error) {
    console.error("[GET /v1/invoices] list failed:", error);
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as unknown as InvoiceRow[]);
  const res: ListInvoicesResponse = { invoices: rows.map(rowToInvoice) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/invoices/:id — single
// ─────────────────────────────────────────────────────────────────────────

invoices.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: GetInvoiceResponse = { invoice: rowToInvoice(data as unknown as InvoiceRow) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/invoices/:id/pdf — render the invoice to a PDF
// ─────────────────────────────────────────────────────────────────────────
//
// Streams application/pdf. The PDF is built fresh from the frozen
// snapshot each call (no caching) — invoices are small and snapshots
// are immutable for sent/paid/void rows, so caching adds complexity
// without a real payoff. If volume grows we can stash the rendered
// PDF on the row.
//
// ?download=1 forces Content-Disposition: attachment; otherwise the
// PDF is served inline so the browser viewer can open it.

invoices.get("/:id/pdf", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const url   = new URL(c.req.url);
  const asDownload = url.searchParams.get("download") === "1";

  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const invoice = rowToInvoice(data as unknown as InvoiceRow);

  // Format dates the same way the on-screen renderer does so the
  // visible header text matches.
  const fmt = (iso?: string) => iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;

  // Logo: pull from the snapshot if we ever start freezing the data
  // URL onto it. For now snapshot.companyLogoUrl is unused, so the PDF
  // renders without a logo. Phase-4 follow-up: when an invoice is
  // generated, fetch the Clerk org image and inline it as base64 so
  // the PDF is fully self-contained.
  const logoData = invoice.snapshot.companyLogoUrl;

  try {
    const { renderInvoicePdf } = await import("../lib/invoicePdf.js");
    const pdf = await renderInvoicePdf({
      snapshot:      invoice.snapshot,
      invoiceNumber: invoice.invoiceNumber,
      issuedDate:    fmt(invoice.issuedAt),
      dueDate:       fmt(invoice.dueAt),
      logoData,
    });
    const filename = `invoice-${invoice.invoiceNumber}.pdf`;
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type":        "application/pdf",
        "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${filename}"`,
        "Cache-Control":       "private, max-age=0, no-store",
      },
    });
  } catch (err) {
    console.error("[GET /v1/invoices/:id/pdf] render failed:", err);
    return c.json({ error: "pdf_render_failed", detail: (err as Error)?.message } satisfies ApiErrorResponse, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/invoices/:id/packet.pdf — merged invoice + rate con + POD bundle
// ─────────────────────────────────────────────────────────────────────────
//
// The "packet" is the canonical broker-facing artifact: a single PDF
// the broker can save / forward in one file. Built on the fly each
// call from the frozen invoice snapshot + the load's rate con and
// selected supporting docs. ?download=1 forces attachment disposition;
// otherwise inline for browser preview.

invoices.get("/:id/packet.pdf", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const url   = new URL(c.req.url);
  const asDownload = url.searchParams.get("download") === "1";

  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const invoice = rowToInvoice(data as unknown as InvoiceRow);

  const fmt = (iso?: string) => iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;

  try {
    const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad } =
      await import("../lib/invoicePacket.js");
    const [extraDocPaths, rateConPath] = await Promise.all([
      resolvePacketDocsForLoad(invoice.loadId, orgId),
      resolveRateConPathForLoad(invoice.loadId, orgId),
    ]);
    const packet = await buildInvoicePacket({
      invoice,
      rateConPath,
      extraDocPaths,
      issuedDate: fmt(invoice.issuedAt),
      dueDate:    fmt(invoice.dueAt),
    });
    const filename = `invoice-packet-${invoice.invoiceNumber}.pdf`;
    return new Response(new Uint8Array(packet.buffer), {
      status: 200,
      headers: {
        "Content-Type":        "application/pdf",
        "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${filename}"`,
        "Cache-Control":       "private, max-age=0, no-store",
      },
    });
  } catch (err) {
    console.error("[GET /v1/invoices/:id/packet.pdf] render failed:", err);
    return c.json({ error: "pdf_render_failed", detail: (err as Error)?.message } satisfies ApiErrorResponse, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /v1/invoices/:id — edit a draft
// ─────────────────────────────────────────────────────────────────────────

invoices.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<UpdateInvoiceRequest>();

  // Load existing — patch only allowed in draft.
  const { data: existing, error: fetchErr } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr) {
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const cur = existing as unknown as InvoiceRow;
  if (cur.status !== "draft") {
    return c.json({ error: "invalid_state", detail: `invoice is ${cur.status}; only drafts can be edited` } satisfies ApiErrorResponse, 409);
  }

  // Build a new snapshot — recompute totals if line items changed.
  const next: InvoiceSnapshot = { ...cur.snapshot };
  let total = cur.total;
  if (body.lineItems !== undefined) {
    next.lineItems    = body.lineItems;
    total             = body.lineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
    next.totalCharges = total;
    next.balanceDue   = total;
  }
  if (body.remitToInstructions !== undefined) {
    next.remitToInstructions = body.remitToInstructions ?? undefined;
  }
  if (body.invoiceFooterNotes !== undefined) {
    next.invoiceFooterNotes = body.invoiceFooterNotes ?? undefined;
  }

  const update: Record<string, unknown> = { snapshot: next, total };
  if (body.invoiceNumber !== undefined && body.invoiceNumber.trim()) {
    update.invoice_number = body.invoiceNumber.trim();
  }
  if (body.dueAt !== undefined) {
    update.due_at = body.dueAt ?? null;
  }
  // Reassign the customer FK + refresh the snapshot's broker name so
  // the printed invoice and the email-recipient lookup land on the
  // same customer. Null clears the broker; a real id swaps to the
  // picked customer. snapshot.email is the carrier's AR email (used
  // for Reply-To), NOT the broker's — leave it alone. The send
  // endpoint resolves the recipient from customers.invoice_email
  // directly at send time.
  if (body.customerId !== undefined) {
    update.customer_id = body.customerId;
    if (body.customerId) {
      const { data: cust, error: custErr } = await supabase
        .from("customers")
        .select("id,name")
        .eq("id", body.customerId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (custErr) {
        return c.json({ error: "customer_lookup_failed", detail: custErr.message } satisfies ApiErrorResponse, 500);
      }
      if (!cust) {
        return c.json({ error: "customer_not_found" } satisfies ApiErrorResponse, 404);
      }
      next.brokerName = (cust as { name: string }).name;
    } else {
      next.brokerName = undefined;
    }
    update.snapshot = next;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("invoices")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(INVOICE_COLS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "duplicate_invoice_number" } satisfies ApiErrorResponse, 409);
    }
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateInvoiceResponse = { invoice: rowToInvoice(data as unknown as InvoiceRow) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/:id/packet — build + persist the merged PDF packet
//
// "Generate" action in the UI. Reuses persistInvoicePacket which renders
// the invoice + appends rate con + appends POD/BOL/etc into a single PDF
// and stores it under load_documents (kind=invoice). The signed URL
// returned here lets the client preview/download without round-tripping
// through the API.
//
// Idempotent — calling repeatedly replaces the previous packet. Send
// still rebuilds fresh at send-time, so an invoice edit between
// Generate and Send produces an email matching the latest state.
// ─────────────────────────────────────────────────────────────────────────

invoices.post("/:id/packet", requireCapability("accounting.access"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data: existing, error: fetchErr } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr) {
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const invoice = rowToInvoice(existing as unknown as InvoiceRow);

  try {
    const { persistInvoicePacket } = await import("../lib/invoicePacket.js");
    const { documentId, storagePath } = await persistInvoicePacket({ invoice, orgId });

    // Mint a 1-hour signed URL so the client can preview / download
    // the packet directly from Supabase storage without going back
    // through our API for the bytes.
    const { data: signed, error: signErr } = await supabase
      .storage
      .from("load-documents")
      .createSignedUrl(storagePath, 3600);
    if (signErr || !signed?.signedUrl) {
      throw new Error(`signed URL mint failed: ${signErr?.message ?? "unknown"}`);
    }

    const res: GenerateInvoicePacketResponse = {
      documentId,
      storagePath,
      signedUrl: signed.signedUrl,
    };
    return c.json(res);
  } catch (err) {
    console.error("[POST /v1/invoices/:id/packet] failed:", err);
    return c.json(
      { error: "packet_build_failed", detail: (err as Error)?.message } satisfies ApiErrorResponse,
      500,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/:id/send — draft → sent
// ─────────────────────────────────────────────────────────────────────────

invoices.post("/:id/send", requireCapability("accounting.send_invoice"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");
  const body   = await c.req.json<SendInvoiceRequest>();

  if (!body?.method || !["email", "portal", "manual"].includes(body.method)) {
    return badRequest(c, ["method must be 'email' | 'portal' | 'manual'"]);
  }

  // For email sends, we need the invoice + (maybe) the load's docs
  // BEFORE flipping status — if the send fails we want the row to
  // stay in draft. Read the invoice up-front for all methods so we
  // can fall through to the email branch with a populated object.
  const { data: existing, error: fetchErr } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr) {
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const invoice = rowToInvoice(existing as unknown as InvoiceRow);
  if (invoice.status !== "draft") {
    return c.json(
      { error: "invalid_state", detail: `invoice is ${invoice.status}; only drafts can be sent` } satisfies ApiErrorResponse,
      409,
    );
  }

  // Resolve recipient for email sends. Fall back to the customer's
  // invoice_email when the caller didn't supply one.
  let recipient = body.to?.trim() || undefined;
  if (body.method === "email" && !recipient && invoice.customerId) {
    const { data: cust } = await supabase
      .from("customers")
      .select("invoice_email")
      .eq("id", invoice.customerId)
      .eq("org_id", orgId)
      .maybeSingle();
    recipient = (cust as { invoice_email: string | null } | null)?.invoice_email?.trim() || undefined;
  }
  if (body.method === "email" && !recipient) {
    return badRequest(c, ["email send requires `to` (or a saved invoice_email on the broker)"]);
  }

  // Resolve BCC. Pull the sending user's email from Clerk so the
  // dispatcher has a record of every invoice they emailed out. We
  // intentionally don't surface this as a configurable address — it
  // tracks the human, not a shared inbox.
  let bccSender: string | undefined;
  if (body.method === "email" && body.bccSelf) {
    try {
      const { clerk } = await import("../lib/clerk.js");
      const user = await clerk().users.getUser(userId);
      const primary = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId);
      bccSender = primary?.emailAddress;
    } catch (err) {
      console.warn("[POST /v1/invoices/:id/send] clerk user lookup failed:", err);
    }
  }

  // Build the merged packet up-front for both email + persistence.
  // For email sends this happens BEFORE the status flip so a Resend
  // failure leaves the invoice in draft. The buffer is reused for
  // the post-send load_documents archive so we don't re-render.
  let packetBuffer: Buffer | undefined;

  if (body.method === "email") {
    try {
      const { sendInvoiceEmail, mergeCcList, loadOrgAutoCc } =
        await import("../lib/invoiceEmail.js");
      const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad } =
        await import("../lib/invoicePacket.js");

      // Pull the org's always-CC address from invoice settings, merge
      // with the per-send cc[] from the request body. Dedup is
      // case-insensitive so a user can't accidentally double-CC the
      // AR inbox by typing it manually.
      const autoCc = await loadOrgAutoCc(orgId);
      const mergedCc = mergeCcList(body.cc, autoCc);

      const fmt = (iso?: string) => iso
        ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : undefined;

      // Build the merged invoice packet (invoice + rate con + POD/etc).
      // attachLoadDocs=false skips the supporting docs entirely — the
      // broker just gets the invoice + rate con. Used when there are
      // privacy concerns about the supporting docs.
      const attachLoadDocs = body.attachLoadDocs ?? true;
      const extraDocPaths = attachLoadDocs
        ? await resolvePacketDocsForLoad(invoice.loadId, orgId)
        : [];
      const rateConPath = await resolveRateConPathForLoad(invoice.loadId, orgId);

      const packet = await buildInvoicePacket({
        invoice,
        rateConPath,
        extraDocPaths,
        issuedDate: fmt(invoice.issuedAt),
        dueDate:    fmt(invoice.dueAt),
      });
      packetBuffer = packet.buffer;
      if (packet.skipped.length) {
        console.warn(
          "[POST /v1/invoices/:id/send] packet skipped some sources:",
          packet.skipped,
        );
      }

      await sendInvoiceEmail({
        invoice,
        to:         recipient!,
        cc:         mergedCc.length ? mergedCc : undefined,
        bccSender,
        bodyText:   body.bodyText,
        attachments: [
          // Single merged attachment — broker AP teams strongly
          // prefer one file over a stack of mismatched PDFs/images.
          {
            filename: `invoice-packet-${invoice.invoiceNumber}.pdf`,
            content:  packet.buffer,
          },
        ],
      });
    } catch (err) {
      const isConfig = err instanceof Error && err.name === "EmailNotConfiguredError";
      console.error("[POST /v1/invoices/:id/send] email send failed:", err);
      return c.json(
        {
          error: isConfig ? "email_not_configured" : "email_send_failed",
          detail: (err as Error)?.message,
        } satisfies ApiErrorResponse,
        isConfig ? 503 : 502,
      );
    }
  }

  // Send succeeded (or method != email) — flip status to sent.
  const update = {
    status:      "sent",
    sent_at:     new Date().toISOString(),
    sent_to:     recipient ?? null,
    sent_method: body.method,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("invoices")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("status", "draft")
    .select(INVOICE_COLS)
    .single();
  if (error) {
    return c.json({ error: "send_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "invalid_state", detail: "invoice not in draft state" } satisfies ApiErrorResponse, 409);
  const sentInvoice = rowToInvoice(data as unknown as InvoiceRow);

  // Archive the packet PDF that was actually sent (for email) or the
  // current packet (for manual/portal). Best-effort — the API has
  // already done its real work; failure here just leaves the docs
  // panel with a slightly stale archive. The /packet.pdf endpoint
  // can always render fresh.
  try {
    const { persistInvoicePacket } = await import("../lib/invoicePacket.js");
    await persistInvoicePacket({
      invoice:  sentInvoice,
      orgId,
      prebuilt: packetBuffer,
    });
  } catch (err) {
    console.warn("[POST /v1/invoices/:id/send] packet persistence failed:", err);
  }

  const res: SendInvoiceResponse = { invoice: sentInvoice };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/batch-generate — generate invoices for many loads
// ─────────────────────────────────────────────────────────────────────────
//
// Source-of-truth bulk action for the Released bucket on /accounting.
// For each loadId, builds the snapshot + inserts an invoice row +
// persists the merged packet PDF. With thenSend=true, follows up by
// firing the standard batch-send flow against the just-created
// invoices (grouped per-broker, one email each).
//
// Per-load isolation: a 23505 (active invoice already exists) or
// any other failure on one load doesn't poison the batch — the
// response carries per-load results so the UI can show exactly
// what landed.

invoices.post("/batch-generate", async (c) => {
  const orgId  = c.get("orgId");
  const body   = await c.req.json<BatchGenerateInvoicesRequest>();

  if (!Array.isArray(body?.loadIds) || body.loadIds.length === 0) {
    return badRequest(c, ["loadIds (non-empty array) required"]);
  }
  if (body.loadIds.length > 50) {
    return badRequest(c, ["batch limited to 50 loads per call"]);
  }

  const created: BatchGenerateInvoicesResponse["created"] = [];
  const failed:  BatchGenerateInvoicesResponse["failed"]  = [];

  // Sequential — invoice number generation reads from a counter and
  // we want predictable ordering. Volumes are small (≤50/req) so the
  // wall-clock difference vs Promise.all is negligible.
  for (const loadId of body.loadIds) {
    try {
      const result = await buildSnapshot(orgId, loadId, {} as Partial<CreateInvoiceRequest>);
      if ("error" in result) {
        failed.push({
          loadId,
          error: result.error.body.detail ?? result.error.body.error,
        });
        continue;
      }
      const { snapshot, total, load, invoiceSettings, dueAt } = result;

      const prefix = invoiceSettings.invoiceNumberPrefix ?? "";
      const invoiceNumber = `${prefix}${load.internal_load_id}`;

      const insertRow = {
        org_id:          orgId,
        load_id:         load.id,
        customer_id:     load.customer_id,
        invoice_number:  invoiceNumber,
        status:          "draft" as InvoiceStatus,
        total,
        issued_at:       new Date().toISOString(),
        due_at:          dueAt,
        snapshot,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: insertErr } = await supabase
        .from("invoices")
        .insert(insertRow as any)
        .select(INVOICE_COLS)
        .single();
      if (insertErr || !data) {
        if ((insertErr as { code?: string } | null)?.code === "23505") {
          failed.push({ loadId, error: "An active invoice already exists for this load." });
        } else {
          failed.push({ loadId, error: insertErr?.message ?? "insert_failed" });
        }
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await supabase.from("loads").update({ billing_status: "invoiced" } as any)
        .eq("id", load.id).eq("org_id", orgId);

      const newInvoice = rowToInvoice(data as unknown as InvoiceRow);

      // Persist packet — best-effort, same as single-create path.
      try {
        const { persistInvoicePacket } = await import("../lib/invoicePacket.js");
        await persistInvoicePacket({ invoice: newInvoice, orgId });
      } catch (err) {
        console.warn("[POST /v1/invoices/batch-generate] packet persistence failed:", err);
      }

      created.push({ loadId, invoice: newInvoice });
    } catch (err) {
      console.error("[POST /v1/invoices/batch-generate] loop error:", err);
      failed.push({ loadId, error: (err as Error)?.message ?? "unknown_error" });
    }
  }

  const res: BatchGenerateInvoicesResponse = { created, failed };

  // Second stage: optional batch-send of the just-created invoices.
  // We call the existing batch-send logic inline rather than re-
  // implementing it. Failures here populate res.sent but don't roll
  // back the generation — the user can retry sends later.
  if (body.thenSend && created.length > 0) {
    const invoiceIds = created.map(c => c.invoice.id);
    try {
      // Build a synthetic Hono request body and re-use the batch-send
      // handler? Simpler: replicate the core grouping/sending logic
      // here. To avoid duplication we share via the email lib.
      const { sendInvoiceEmail } =
        await import("../lib/invoiceEmail.js");
      const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad, persistInvoicePacket } =
        await import("../lib/invoicePacket.js");

      // Re-read invoices to ensure we have the latest snapshot + customer.
      const { data: rows } = await supabase
        .from("invoices")
        .select(INVOICE_COLS)
        .eq("org_id", orgId)
        .in("id", invoiceIds);
      const invs = ((rows ?? []) as unknown as InvoiceRow[]).map(rowToInvoice);

      // Group by broker.
      const byBroker = new Map<string, typeof invs>();
      for (const inv of invs) {
        if (!inv.customerId) continue; // brokerless invoices can't be auto-sent
        const list = byBroker.get(inv.customerId) ?? [];
        list.push(inv);
        byBroker.set(inv.customerId, list);
      }
      const { data: customerRows } = await supabase
        .from("customers")
        .select("id,name,invoice_email")
        .eq("org_id", orgId)
        .in("id", Array.from(byBroker.keys()));
      const customerById = new Map<string, { name: string; invoice_email: string | null }>();
      for (const row of (customerRows ?? []) as Array<{ id: string; name: string; invoice_email: string | null }>) {
        customerById.set(row.id, { name: row.name, invoice_email: row.invoice_email });
      }

      let bccSender: string | undefined;
      if (body.bccSelf) {
        try {
          const { clerk } = await import("../lib/clerk.js");
          const user = await clerk().users.getUser(c.get("userId"));
          const primary = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId);
          bccSender = primary?.emailAddress;
        } catch { /* ignore — bcc-self is best-effort */ }
      }

      const fmt = (iso?: string) => iso
        ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : undefined;
      const attachLoadDocs = body.attachLoadDocs ?? true;

      const groups: BatchSendInvoicesResponse["groups"] = [];
      for (const [customerId, brokerInvs] of byBroker) {
        const customer = customerById.get(customerId);
        const brokerName = customer?.name ?? brokerInvs[0]?.snapshot.brokerName ?? "Unknown broker";
        const recipient  = customer?.invoice_email?.trim() || undefined;
        if (!recipient) {
          groups.push({
            customerId, brokerName, to: null,
            status: "skipped_no_email", invoiceIds: brokerInvs.map(i => i.id),
          });
          continue;
        }

        const built: Array<{ invoice: typeof brokerInvs[number]; packet: Buffer }> = [];
        try {
          for (const inv of brokerInvs) {
            const [extraDocPaths, rateConPath] = await Promise.all([
              attachLoadDocs ? resolvePacketDocsForLoad(inv.loadId, orgId) : Promise.resolve<string[]>([]),
              resolveRateConPathForLoad(inv.loadId, orgId),
            ]);
            const packet = await buildInvoicePacket({
              invoice: inv, rateConPath, extraDocPaths,
              issuedDate: fmt(inv.issuedAt), dueDate: fmt(inv.dueAt),
            });
            built.push({ invoice: inv, packet: packet.buffer });
          }
        } catch (err) {
          groups.push({
            customerId, brokerName, to: recipient, status: "failed",
            invoiceIds: brokerInvs.map(i => i.id),
            error: `packet build failed: ${(err as Error)?.message}`,
          });
          continue;
        }

        let messageId: string | undefined;
        try {
          const sendRes = await sendInvoiceEmail({
            invoice:     built[0].invoice,
            to:          recipient,
            cc:          body.cc,
            bccSender,
            bodyText:    body.bodyText,
            attachments: built.map(b => ({
              filename: `invoice-packet-${b.invoice.invoiceNumber}.pdf`,
              content:  b.packet,
            })),
          });
          messageId = sendRes.messageId;
        } catch (err) {
          groups.push({
            customerId, brokerName, to: recipient, status: "failed",
            invoiceIds: brokerInvs.map(i => i.id),
            error: (err as Error)?.message ?? "email send failed",
          });
          continue;
        }

        const sentInvoiceIds: string[] = [];
        for (const { invoice: inv, packet } of built) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: upd } = await supabase
            .from("invoices")
            .update({
              status:      "sent",
              sent_at:     new Date().toISOString(),
              sent_to:     recipient,
              sent_method: "email",
            } as any)
            .eq("id", inv.id)
            .eq("org_id", orgId)
            .eq("status", "draft")
            .select(INVOICE_COLS)
            .single();
          if (!upd) continue;
          const sentInv = rowToInvoice(upd as unknown as InvoiceRow);
          sentInvoiceIds.push(sentInv.id);
          try {
            await persistInvoicePacket({ invoice: sentInv, orgId, prebuilt: packet });
          } catch { /* best-effort */ }
        }

        groups.push({
          customerId, brokerName, to: recipient, status: "sent",
          invoiceIds: sentInvoiceIds, messageId,
        });
      }

      res.sent = groups;
    } catch (err) {
      console.error("[POST /v1/invoices/batch-generate] thenSend stage failed:", err);
      // Don't fail the request — generation succeeded, just report
      // empty groups so the UI knows send didn't run.
      res.sent = [];
    }
  }

  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/batch-send — send a set of draft invoices, grouped
// by broker.
// ─────────────────────────────────────────────────────────────────────────
//
// Operates per-broker: one email per unique customer_id, with all of
// that broker's selected drafts attached as separate merged packets.
// A group that fails (missing recipient, Resend error) leaves its
// invoices in draft so the user can retry just that one. Groups that
// succeed independently flip to sent and persist their packets.

invoices.post("/batch-send", requireCapability("accounting.send_invoice"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const body   = await c.req.json<BatchSendInvoicesRequest>();

  if (!Array.isArray(body?.invoiceIds) || body.invoiceIds.length === 0) {
    return badRequest(c, ["invoiceIds (non-empty array) required"]);
  }
  if (body.invoiceIds.length > 50) {
    return badRequest(c, ["batch limited to 50 invoices per call"]);
  }

  // Load every selected invoice up-front.
  const { data: rows, error: fetchErr } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("org_id", orgId)
    .in("id", body.invoiceIds);
  if (fetchErr) {
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  const allInvoices = ((rows ?? []) as unknown as InvoiceRow[]).map(rowToInvoice);
  if (allInvoices.length !== body.invoiceIds.length) {
    return badRequest(c, ["one or more invoiceIds not found in this org"]);
  }
  const badStatus = allInvoices.find(i => i.status !== "draft");
  if (badStatus) {
    return badRequest(c, [`invoice ${badStatus.invoiceNumber} is ${badStatus.status}; batch send only works on drafts`]);
  }

  // Resolve the broker for each invoice. Two-level fallback chain:
  //   1. invoice.customer_id   (frozen at draft time)
  //   2. load.customer_id      (current FK on the load row — picks up
  //      the case where the dispatcher set the broker AFTER drafting)
  //
  // No text-name guessing. The broker picker writes load.customer_id
  // (the leak in EventModal.doSave was fixed in a separate change);
  // if customer_id is missing on both, the load genuinely has no
  // linked customer record and the user must open the load and pick
  // one from the broker picker.
  //
  // Hard-fails only if both levels miss.
  const loadIdsForFallback = Array.from(new Set(
    allInvoices.filter(i => !i.customerId).map(i => i.loadId),
  ));
  const loadCustomerById = new Map<string, string | null>();
  if (loadIdsForFallback.length > 0) {
    const { data: loadRows } = await supabase
      .from("loads")
      .select("id,customer_id")
      .eq("org_id", orgId)
      .in("id", loadIdsForFallback);
    for (const row of (loadRows ?? []) as Array<{ id: string; customer_id: string | null }>) {
      loadCustomerById.set(row.id, row.customer_id);
    }
  }
  const resolvedCustomerByInvoiceId = new Map<string, string>();
  const stillNoBroker: string[] = [];
  for (const inv of allInvoices) {
    const cid = inv.customerId ?? loadCustomerById.get(inv.loadId) ?? null;
    if (!cid) stillNoBroker.push(inv.invoiceNumber);
    else resolvedCustomerByInvoiceId.set(inv.id, cid);
  }
  if (stillNoBroker.length > 0) {
    return badRequest(c, [`invoice(s) ${stillNoBroker.join(", ")} have no linked customer. Open the load and pick a broker from the customer picker (not just freeform text).`]);
  }

  // Group by resolved customer_id. Preserves order within each group.
  const byBroker = new Map<string, Invoice[]>();
  for (const inv of allInvoices) {
    const cid = resolvedCustomerByInvoiceId.get(inv.id)!;
    const list = byBroker.get(cid) ?? [];
    list.push(inv);
    byBroker.set(cid, list);
  }

  // Resolve recipients for each broker in one query.
  const { data: customerRows } = await supabase
    .from("customers")
    .select("id,name,invoice_email")
    .eq("org_id", orgId)
    .in("id", Array.from(byBroker.keys()));
  const customerById = new Map<string, { name: string; invoice_email: string | null }>();
  for (const row of (customerRows ?? []) as Array<{ id: string; name: string; invoice_email: string | null }>) {
    customerById.set(row.id, { name: row.name, invoice_email: row.invoice_email });
  }

  // Resolve the sender's email once if bcc-self was requested.
  let bccSender: string | undefined;
  if (body.bccSelf) {
    try {
      const { clerk } = await import("../lib/clerk.js");
      const user = await clerk().users.getUser(userId);
      const primary = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId);
      bccSender = primary?.emailAddress;
    } catch (err) {
      console.warn("[POST /v1/invoices/batch-send] clerk user lookup failed:", err);
    }
  }

  const { sendInvoiceEmail, mergeCcList, loadOrgAutoCc } =
    await import("../lib/invoiceEmail.js");
  const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad, persistInvoicePacket } =
    await import("../lib/invoicePacket.js");

  const fmt = (iso?: string) => iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;

  const attachLoadDocs = body.attachLoadDocs ?? true;

  // One DB hit per request — the auto-CC applies to every broker
  // group in this batch.
  const autoCc = await loadOrgAutoCc(orgId);
  const mergedCc = mergeCcList(body.cc, autoCc);

  const groups: BatchSendInvoicesResponse["groups"] = [];

  for (const [customerId, invs] of byBroker) {
    const customer  = customerById.get(customerId);
    const brokerName = customer?.name ?? invs[0]?.snapshot.brokerName ?? "Unknown broker";
    const recipient  = customer?.invoice_email?.trim() || undefined;

    if (!recipient) {
      groups.push({
        customerId,
        brokerName,
        to:         null,
        status:     "skipped_no_email",
        invoiceIds: invs.map(i => i.id),
      });
      continue;
    }

    // Build a merged packet per invoice. Same logic as the single
    // /send endpoint, just looped.
    type PerInvoice = { invoice: Invoice; packet: Buffer };
    const built: PerInvoice[] = [];
    try {
      for (const inv of invs) {
        const [extraDocPaths, rateConPath] = await Promise.all([
          attachLoadDocs ? resolvePacketDocsForLoad(inv.loadId, orgId) : Promise.resolve<string[]>([]),
          resolveRateConPathForLoad(inv.loadId, orgId),
        ]);
        const packet = await buildInvoicePacket({
          invoice:     inv,
          rateConPath,
          extraDocPaths,
          issuedDate:  fmt(inv.issuedAt),
          dueDate:     fmt(inv.dueAt),
        });
        if (packet.skipped.length) {
          console.warn("[batch-send] packet skipped:", inv.invoiceNumber, packet.skipped);
        }
        built.push({ invoice: inv, packet: packet.buffer });
      }
    } catch (err) {
      console.error("[batch-send] packet build failed for broker", brokerName, err);
      groups.push({
        customerId,
        brokerName,
        to:         recipient,
        status:     "failed",
        invoiceIds: invs.map(i => i.id),
        error:      `packet build failed: ${(err as Error)?.message}`,
      });
      continue;
    }

    // One email per broker, packets as separate attachments.
    let messageId: string | undefined;
    try {
      // sendInvoiceEmail expects an Invoice for From/Reply-To
      // computation. With a multi-invoice send we use the first
      // invoice's snapshot — they all share the same org identity
      // because they're from the same Clerk org.
      const result = await sendInvoiceEmail({
        invoice:     built[0].invoice,
        to:          recipient,
        cc:          mergedCc.length ? mergedCc : undefined,
        bccSender,
        bodyText:    body.bodyText,
        attachments: built.map(b => ({
          filename: `invoice-packet-${b.invoice.invoiceNumber}.pdf`,
          content:  b.packet,
        })),
      });
      messageId = result.messageId;
    } catch (err) {
      console.error("[batch-send] email send failed for broker", brokerName, err);
      groups.push({
        customerId,
        brokerName,
        to:         recipient,
        status:     "failed",
        invoiceIds: invs.map(i => i.id),
        error:      (err as Error)?.message ?? "email send failed",
      });
      continue;
    }

    // Flip all invoices in this group to sent + archive each packet.
    const sentInvoiceIds: string[] = [];
    for (const { invoice: inv, packet } of built) {
      // If this invoice's customer_id was null and we resolved via the
      // load fallback, write the resolved id back to the row so future
      // queries / listings don't keep needing the fallback. Snapshot
      // text (broker name in the PDF) stays as-is for audit integrity;
      // a dispatcher who cares about that can Regenerate first.
      const updateRow: Record<string, unknown> = {
        status:      "sent",
        sent_at:     new Date().toISOString(),
        sent_to:     recipient,
        sent_method: "email",
      };
      if (!inv.customerId) {
        updateRow.customer_id = customerId;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase
        .from("invoices")
        .update(updateRow as any)
        .eq("id", inv.id)
        .eq("org_id", orgId)
        .eq("status", "draft")
        .select(INVOICE_COLS)
        .single();
      if (error || !data) {
        console.warn("[batch-send] flip-to-sent failed for", inv.invoiceNumber, error);
        continue;
      }
      const sentInv = rowToInvoice(data as unknown as InvoiceRow);
      sentInvoiceIds.push(sentInv.id);

      // Archive the packet — best-effort.
      try {
        await persistInvoicePacket({ invoice: sentInv, orgId, prebuilt: packet });
      } catch (persistErr) {
        console.warn("[batch-send] packet persistence failed for", sentInv.invoiceNumber, persistErr);
      }
    }

    groups.push({
      customerId,
      brokerName,
      to:         recipient,
      status:     "sent",
      invoiceIds: sentInvoiceIds,
      messageId,
    });
  }

  const res: BatchSendInvoicesResponse = { groups };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/:id/mark-paid — sent → paid
// ─────────────────────────────────────────────────────────────────────────

invoices.post("/:id/mark-paid", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<MarkInvoicePaidRequest>();

  const update = {
    status:      "paid",
    paid_at:     body.paidAt ?? new Date().toISOString(),
    paid_amount: body.amount ?? null,
    paid_method: body.method ?? null,
    paid_note:   body.note   ?? null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("invoices")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .in("status", ["draft", "sent"])    // can mark paid from either state
    .select(INVOICE_COLS)
    .single();
  if (error) {
    return c.json({ error: "mark_paid_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "invalid_state", detail: "invoice is void or already paid" } satisfies ApiErrorResponse, 409);

  // Mirror onto loads.billing_status so the closeout queue advances.
  const invoice = data as unknown as InvoiceRow;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from("loads").update({ billing_status: "paid" } as any)
    .eq("id", invoice.load_id).eq("org_id", orgId);

  const res: MarkInvoicePaidResponse = { invoice: rowToInvoice(invoice) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/:id/void — flip to void
// ─────────────────────────────────────────────────────────────────────────

invoices.post("/:id/void", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<VoidInvoiceRequest>().catch(() => ({} as VoidInvoiceRequest));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("invoices")
    .update({ status: "void", void_reason: body.reason ?? null } as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .neq("status", "void")
    .select(INVOICE_COLS)
    .single();
  if (error) {
    return c.json({ error: "void_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "invalid_state", detail: "invoice already void" } satisfies ApiErrorResponse, 409);

  // Revert load's billing_status — voiding releases the load back to the
  // verified queue so it can be re-invoiced.
  const invoice = data as unknown as InvoiceRow;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from("loads").update({ billing_status: "verified" } as any)
    .eq("id", invoice.load_id).eq("org_id", orgId);

  const res: VoidInvoiceResponse = { invoice: rowToInvoice(invoice) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/:id/regenerate — refresh from current load data
// ─────────────────────────────────────────────────────────────────────────
//
// Use case: dispatcher uploaded a missing POD, fixed an accessorial, or
// updated a stop after the invoice was already drafted. The on-disk
// snapshot is now stale. Regenerate rebuilds the snapshot from latest
// load data and refreshes the packet PDF, keeping the same invoice id
// + number so the row's history stays intact.
//
// Status semantics:
//   - draft  → refresh in place (most common path)
//   - void   → revive to draft + refresh. Recovers invoices that got
//              stuck void by an earlier failed regenerate run. Treated
//              as "the latest attempt is what counts" — drafts that
//              never shipped have no audit-trail value to preserve.
//   - sent   → 409. Broker has it; void it manually first if you need
//              to replace.
//   - paid   → 409. Same reasoning + accounting just doesn't want
//              paid invoices mutating under it.
//
// Why UPDATE-in-place rather than void + insert:
//   `idx_invoices_number_per_org` is unconditional (covers void too),
//   so a void+insert flow with the same invoice_number trips 23505.
//   UPDATE on the same row sidesteps it entirely.

invoices.post("/:id/regenerate", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  // Same body shape as create. loadId is optional — we already know it
  // from the existing invoice. Other fields are overrides.
  const body = await c.req.json<Partial<CreateInvoiceRequest>>().catch(() => ({} as Partial<CreateInvoiceRequest>));

  // 1. Load the existing invoice.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingRow, error: fetchErr } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .single();
  if (fetchErr || !existingRow) {
    return c.json({ error: "not_found", detail: "invoice not found" } satisfies ApiErrorResponse, 404);
  }
  const existing = existingRow as unknown as InvoiceRow;
  if (existing.status === "sent" || existing.status === "paid") {
    return c.json(
      { error: "invalid_state", detail: `cannot regenerate ${existing.status} invoice — void it first if you need to replace it` } satisfies ApiErrorResponse,
      409,
    );
  }
  const wasVoided = existing.status === "void";
  const loadId = existing.load_id;
  const carryInvoiceNumber = body.invoiceNumber ?? existing.invoice_number;

  // 2. Build the fresh snapshot. Surfaces the same validation errors as
  //    POST /v1/invoices so callers see consistent failure modes.
  const result = await buildSnapshot(orgId, loadId, { ...body, invoiceNumber: carryInvoiceNumber });
  if ("error" in result) {
    return c.json(result.error.body, result.error.status as 400 | 404 | 500);
  }
  const { snapshot, total, load, dueAt } = result;

  // 3. Update the existing row in place. Reviving a void invoice means
  //    flipping status back to draft + clearing void_reason; otherwise
  //    we just refresh the data fields.
  const updateRow: Record<string, unknown> = {
    customer_id: load.customer_id,
    total,
    issued_at:   new Date().toISOString(),
    due_at:      dueAt,
    snapshot,
    invoice_number: carryInvoiceNumber,
  };
  if (wasVoided) {
    updateRow.status      = "draft";
    updateRow.void_reason = null;
  }
  // Acceptable starting states: draft or void. Sent/paid were rejected above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updatedRow, error: updateErr } = await supabase
    .from("invoices")
    .update(updateRow as any)
    .eq("id", existing.id)
    .eq("org_id", orgId)
    .in("status", ["draft", "void"])
    .select(INVOICE_COLS)
    .single();
  if (updateErr) {
    if ((updateErr as { code?: string }).code === "23505") {
      return c.json(
        { error: "invoice_exists", detail: "the new invoice number is already taken by another invoice in this org" } satisfies ApiErrorResponse,
        409,
      );
    }
    console.error("[POST /v1/invoices/:id/regenerate] update failed:", updateErr);
    return c.json({ error: "update_failed", detail: updateErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!updatedRow) {
    return c.json(
      { error: "invalid_state", detail: "invoice changed status during regenerate; refresh and try again" } satisfies ApiErrorResponse,
      409,
    );
  }

  // 4. If we revived a void invoice, mirror billing_status back to
  //    'invoiced' on the load (the original void had flipped it to
  //    verified, or it could be in any state if other ops touched it).
  if (wasVoided) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase.from("loads").update({ billing_status: "invoiced" } as any)
      .eq("id", load.id).eq("org_id", orgId);
  }

  const newInvoice = rowToInvoice(updatedRow as unknown as InvoiceRow);

  // 5. Replace the archived packet doc. persistInvoicePacket clears any
  //    prior packet rows for this invoice id automatically before
  //    writing the new one.
  try {
    const { persistInvoicePacket } = await import("../lib/invoicePacket.js");
    await persistInvoicePacket({ invoice: newInvoice, orgId });
  } catch (err) {
    console.warn("[POST /v1/invoices/:id/regenerate] packet persistence failed:", err);
  }

  const res: CreateInvoiceResponse = { invoice: newInvoice };
  return c.json(res, 200);
});

export default invoices;
