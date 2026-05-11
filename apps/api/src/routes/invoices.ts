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
import type { AuthVariables } from "../middleware/clerk.js";

const invoices = new Hono<{ Variables: AuthVariables }>();

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

  const snapshot: InvoiceSnapshot = {
    companyName:    invoiceSettings.companyName ?? "",
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

  const res: CreateInvoiceResponse = { invoice: rowToInvoice(data as unknown as InvoiceRow) };
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
// POST /v1/invoices/:id/send — draft → sent
// ─────────────────────────────────────────────────────────────────────────

invoices.post("/:id/send", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<SendInvoiceRequest>();

  if (!body?.method || !["email", "portal", "manual"].includes(body.method)) {
    return badRequest(c, ["method must be 'email' | 'portal' | 'manual'"]);
  }

  const update = {
    status:      "sent",
    sent_at:     new Date().toISOString(),
    sent_to:     body.to ?? null,
    sent_method: body.method,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("invoices")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("status", "draft")        // only drafts can transition to sent
    .select(INVOICE_COLS)
    .single();
  if (error) {
    return c.json({ error: "send_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "invalid_state", detail: "invoice not in draft state" } satisfies ApiErrorResponse, 409);
  const res: SendInvoiceResponse = { invoice: rowToInvoice(data as unknown as InvoiceRow) };
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

export default invoices;
