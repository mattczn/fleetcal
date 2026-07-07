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
  type UnmarkInvoicePaidRequest,
  type UnmarkInvoicePaidResponse,
  type VoidInvoiceRequest,
  type VoidInvoiceResponse,
  type BatchResendInvoicesRequest,
  type BatchResendInvoicesResponse,
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
import { appendLoadAudit } from "../lib/auditLog.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { pMapWithLimit } from "../lib/concurrency.js";

/**
 * Set loads.billing_status AND write a load-level audit entry in one
 * call. Reads the prior value first so the audit shows the actual
 * transition (e.g. "verified → invoiced") instead of just the new
 * value. No-ops the audit when the value didn't actually change —
 * which fires often because multiple invoice flows can repeatedly
 * mark a load "invoiced" without it being a new transition.
 *
 * Used by every billing-status mutation in invoices.ts so the
 * History panel in the load modal shows the closeout/invoicing
 * timeline alongside dispatcher edits.
 */
async function setBillingStatus(
  loadId:    string,
  orgId:     string,
  next:      "pending" | "verified" | "invoiced" | "paid" | "on_hold",
  actorName: string | undefined,
): Promise<void> {
  const { data: prior } = await supabase
    .from("loads")
    .select("billing_status")
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  const prev = (prior as { billing_status: string | null } | null)?.billing_status ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase.from("loads").update({ billing_status: next } as any)
    .eq("id", loadId).eq("org_id", orgId);
  if (prev !== next) {
    await appendLoadAudit(loadId, orgId, {
      changedAt:         new Date().toISOString(),
      changedByName:     actorName ?? "Invoicing",
      prevBillingStatus: (prev ?? undefined) as never,
      newBillingStatus:  next,
    });
  }
}

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
  id:               string;
  name:             string;
  invoice_email:    string | null;
  billing_address:  string | null;
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

  // ── Customer-id name fallback ────────────────────────────────────
  // Mirrors the accounting page's findCustomerForLoad: when the FK
  // is missing but the broker text-field matches a single customer
  // by name or alias, treat that customer as the linked one. Without
  // this every invoice generated from a load that was created via a
  // path that didn't set customer_id (legacy rows, AI-parse imports
  // that pre-date the FK plumbing, etc.) ended up with NULL
  // customer_id even though the dispatcher's table clearly showed
  // a broker — the user then had to manually re-pick from the
  // InvoiceDetailModal.
  //
  // Conservative match: case-insensitive exact name.
  // We skip ambiguous matches (>1 customer matched) to avoid
  // silently picking the wrong broker. Backfilled to loads.customer_id
  // best-effort so future ops see the FK.
  if (!load.customer_id && load.broker?.trim()) {
    const brokerText = load.broker.trim();
    const lower = brokerText.toLowerCase();
    // Fetch the org's customer roster and filter in code — simpler
    // than wrestling with PostgREST's array-contains syntax for the
    // alias side, and the customer table is small (~hundreds of rows
    // per org) so the round-trip cost is negligible.
    const { data: candidateRows, error: candErr } = await supabase
      .from("customers")
      .select("id,name")
      .eq("org_id", orgId);
    if (!candErr) {
      const matches = ((candidateRows ?? []) as Array<{ id: string; name: string }>)
        .filter(c => c.name.toLowerCase() === lower);
      if (matches.length === 1) {
        load.customer_id = matches[0].id;
        // Best-effort backfill — don't fail invoice creation if the
        // write is rejected (RLS, race with a concurrent edit, etc.).
        // The .is('customer_id', null) guards against clobbering
        // the FK if another writer set it between the read and write.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void supabase
          .from("loads")
          .update({ customer_id: matches[0].id } as any)
          .eq("id", loadId)
          .eq("org_id", orgId)
          .is("customer_id", null)
          .then(({ error: backfillErr }) => {
            if (backfillErr) {
              console.warn("[buildSnapshot] customer_id backfill failed:", backfillErr);
            }
          });
      }
    }
  }

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
      .select("id,name,invoice_email,billing_address")
      .eq("id", load.customer_id)
      .eq("org_id", orgId)
      .maybeSingle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customer = (custRow as any as CustomerRowForInvoice | null) ?? null;
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
    // The customer's billing address — populated either by the
    // dispatcher in the customer profile or extracted by the rate-con
    // AI. Snapshotted at generation time so edits to the customer
    // record don't retroactively change past invoices.
    brokerBillingAddress: customer?.billing_address ?? undefined,
    // Legacy structured line fields kept for back-compat with old
    // invoice snapshots that used them. New invoices put the address
    // into brokerBillingAddress as a single multi-line string.
    brokerAddrLine1:   undefined,
    brokerAddrLine2:   undefined,

    orderNo:        load.load_num ?? undefined,
    poNumber:       undefined,
    // orderDate intentionally left undefined — pickupDate already
    // anchors the order timeline and the broker doesn't need both.
    orderDate:      undefined,
    pickupDate:     isoDayToDisplay(isoDay(firstStart)),
    deliveredDate:  isoDayToDisplay(isoDay(lastEnd)),
    // Prefer the broker-supplied load number on the invoice — that's
    // the reference the customer uses on their side. Fall back to
    // internal_load_id when the broker # is missing so the cell
    // never blanks out. The invoice number at the top of the doc
    // already carries our internal id (+ optional prefix), so we
    // don't duplicate it here.
    loadNumber:     load.load_num?.trim() || String(load.internal_load_id),

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

  // ── Auto-heal stale sent/paid invoice ───────────────────────────
  // The load is the source of truth for "is this invoiced?". If a
  // sent/paid invoice exists but the load is back in verified /
  // pending / on_hold (the dispatcher reverted it and the closeout
  // PATCH didn't fire — pre-auto-void data, direct DB edits,
  // unusual paths), void the stale invoice up front so the
  // void-revive branch below can pick it up. Without this, the
  // single-create path used to 23505 on insert with no recovery,
  // leaving the user permanently stuck.
  const { data: activeRow } = await supabase
    .from("invoices")
    .select("id,status")
    .eq("org_id", orgId)
    .eq("load_id", load.id)
    .neq("status", "void")
    .maybeSingle();
  if (activeRow) {
    const activeTyped = activeRow as unknown as { id: string; status: string };
    if (activeTyped.status === "sent" || activeTyped.status === "paid") {
      const { data: loadStateRow } = await supabase
        .from("loads")
        .select("billing_status")
        .eq("id", load.id)
        .eq("org_id", orgId)
        .maybeSingle();
      const billingStatus = (loadStateRow as { billing_status: string | null } | null)?.billing_status ?? null;
      const loadIsStale = billingStatus !== "invoiced" && billingStatus !== "paid";
      if (loadIsStale) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await supabase.from("invoices").update({
          status:      "void",
          void_reason: `Auto-voided: load is in '${billingStatus ?? "unknown"}' state, not invoiced/paid`,
        } as any)
          .eq("id", activeTyped.id)
          .eq("org_id", orgId);
        console.log(`[POST /v1/invoices auto-heal] voided stale ${activeTyped.status} invoice ${activeTyped.id} for load ${load.id} (billing_status=${billingStatus})`);
      }
    }
  }

  // Look for a void invoice on this load. If one exists, REVIVE it
  // instead of inserting a fresh row. Reason: the schema's
  // idx_invoices_number_per_org index is unconditional (void rows keep
  // their number reserved), so a fresh insert with the load's natural
  // invoice_number trips 23505 every time on a previously-voided load.
  // Reviving the most recent void is semantically identical to "create
  // a new draft for this load" — same load_id, same number, freshly
  // computed snapshot/total — and avoids the dead-end UX where a load
  // with a stale void becomes uninvoiceable.
  //
  // Ordered newest-first so if multiple voids somehow exist we pick
  // the latest. Only fires when no active (non-void) invoice exists —
  // an active draft/sent/paid invoice still trips the partial unique
  // index downstream and returns 409 as expected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: voidRows } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("org_id", orgId)
    .eq("load_id", load.id)
    .eq("status", "void")
    .order("issued_at", { ascending: false })
    .limit(1);
  const existingVoid = ((voidRows ?? [])[0] as unknown as InvoiceRow | undefined);

  let data: unknown;
  let error: { code?: string; message: string } | null = null;

  if (existingVoid) {
    // Revive: flip status back to draft, refresh snapshot/total/dates,
    // clear void_reason. Same single-row UPDATE the regenerate
    // endpoint uses for the void→draft case.
    const updateRow = {
      customer_id:     load.customer_id,
      invoice_number:  invoiceNumber,
      status:          "draft" as InvoiceStatus,
      void_reason:     null,
      total,
      issued_at:       new Date().toISOString(),
      due_at:          dueAt,
      snapshot,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upd = await supabase
      .from("invoices")
      .update(updateRow as any)
      .eq("id", existingVoid.id)
      .eq("org_id", orgId)
      .eq("status", "void")
      .select(INVOICE_COLS)
      .single();
    data  = upd.data;
    error = upd.error;
  } else {
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
    const ins = await supabase
      .from("invoices")
      .insert(insertRow as any)
      .select(INVOICE_COLS)
      .single();
    data  = ins.data;
    error = ins.error;
  }

  if (error) {
    // 23505 = unique_violation — at this point most likely an
    // active invoice already exists for this load (partial unique
    // index `idx_invoices_load_active` excludes void, so this catches
    // the genuine duplicate case after the revive branch is taken).
    if ((error as { code?: string }).code === "23505") {
      return c.json(
        { error: "invoice_exists", detail: "an active invoice already exists for this load or invoice number" } satisfies ApiErrorResponse,
        409,
      );
    }
    console.error("[POST /v1/invoices] write failed:", error);
    return c.json({ error: "insert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  // Mirror onto loads.billing_status so the closeout queue advances.
  // Helper writes the load row + a load-level audit entry in one
  // call (no-op when value didn't change). Actor name is left
  // undefined here so the helper falls back to "Invoicing" — the
  // POST /v1/invoices flow doesn't carry a dispatcher's typed name
  // through the request body the way closeout actions do.
  await setBillingStatus(load.id, orgId, "invoiced", undefined);

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
  // 201 for fresh insert, 200 for the void→draft revive.
  return c.json(res, existingVoid ? 200 : 201);
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
      const { sendInvoiceEmail, mergeCcList, loadOrgInvoiceSettings } =
        await import("../lib/invoiceEmail.js");
      const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad } =
        await import("../lib/invoicePacket.js");

      // Pull the org's invoice settings — both the auto-CC address AND
      // the subject/body templates flow from this single fetch.
      const orgInvoiceSettings = await loadOrgInvoiceSettings(orgId);
      const mergedCc = mergeCcList(body.cc, orgInvoiceSettings?.ccEmail);

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
      // Refuse to ship a packet that lost selected supporting docs
      // unless the dispatcher explicitly opted in (allowPartialPacket).
      // Prior behavior was to console.warn and email the broker
      // anyway — the dispatcher had no idea their POD/BOL/etc. weren't
      // attached. Returning 422 with the failing paths forces the
      // mistake to surface in the UI before it becomes a billing fight.
      if (packet.skipped.length && !body.allowPartialPacket) {
        console.warn(
          "[POST /v1/invoices/:id/send] refusing send — packet incomplete:",
          packet.skipped,
        );
        return c.json(
          {
            error:  "packet_incomplete",
            detail: `${packet.skipped.length} selected doc${packet.skipped.length === 1 ? "" : "s"} failed to attach. Fix them and retry, or resend with allowPartialPacket=true to ship the packet without them.`,
            errors: packet.skipped.map(s => `${s.path} (${s.reason})`),
          } satisfies ApiErrorResponse,
          422,
        );
      }
      if (packet.skipped.length) {
        console.warn(
          "[POST /v1/invoices/:id/send] sending with skipped sources (allowPartialPacket=true):",
          packet.skipped,
        );
      }

      await sendInvoiceEmail({
        invoices:        [invoice],
        invoiceSettings: orgInvoiceSettings,
        to:              recipient!,
        cc:              mergedCc.length ? mergedCc : undefined,
        bccSender,
        bodyText:        body.bodyText,
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

      // ── Rescue existing draft ───────────────────────────────────
      // If an active (non-void) invoice already exists for this
      // load, "Create & Send" used to fail with a 23505 unique-
      // constraint violation. That state shouldn't be reachable in
      // a happy-path flow, but we've seen it in production: a load
      // ends up in Released (billing_status='verified') even though
      // an invoice row already exists — usually because a previous
      // generate succeeded server-side but the billing_status flip
      // didn't land (interrupted request, manual reset, etc.).
      // The dispatcher then can't push the load forward without
      // hand-fixing the DB.
      //
      // Instead: look for an existing draft first. If found, treat
      // it as "this is the invoice for this load" and continue
      // through the same packet-persist + thenSend pipeline a
      // fresh insert would. Sent / paid existing invoices skip the
      // rescue because the load was already invoiced — surface a
      // softer message so the user knows it's the same row, not a
      // dup attempt.
      let invoiceRow: unknown = null;
      let rescued = false;
      const { data: existingRow } = await supabase
        .from("invoices")
        .select(INVOICE_COLS)
        .eq("org_id", orgId)
        .eq("load_id", load.id)
        .neq("status", "void")
        .maybeSingle();
      // ── Auto-heal stale sent/paid invoice ───────────────────────
      // The load is the source of truth for "is this invoiced?".
      // If we find a sent/paid invoice but the load is back in
      // verified / pending / on_hold (e.g. the dispatcher reverted
      // it and the closeout PATCH didn't fire — pre-auto-void data,
      // direct DB edits, etc.), void the stale invoice and treat
      // the load as needing a fresh draft. The next iteration
      // through the rescue branch will pick up the void via the
      // separate void-revive path below. Without this, the user is
      // permanently stuck with "Already invoiced (status: sent).
      // Refresh to update the bucket." every time they re-attempt.
      if (existingRow) {
        const existingTyped = existingRow as unknown as { id: string; status: string };
        if (existingTyped.status !== "draft") {
          const { data: loadStateRow } = await supabase
            .from("loads")
            .select("billing_status")
            .eq("id", load.id)
            .eq("org_id", orgId)
            .maybeSingle();
          const billingStatus = (loadStateRow as { billing_status: string | null } | null)?.billing_status ?? null;
          const loadIsStale = billingStatus !== "invoiced" && billingStatus !== "paid";
          if (loadIsStale) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await supabase.from("invoices").update({
              status:      "void",
              void_reason: `Auto-voided: load is in '${billingStatus ?? "unknown"}' state, not invoiced/paid`,
            } as any)
              .eq("id", existingTyped.id)
              .eq("org_id", orgId);
            console.log(`[batch-generate auto-heal] voided stale ${existingTyped.status} invoice ${existingTyped.id} for load ${load.id} (billing_status=${billingStatus})`);
            // Don't reuse existingRow — fall through to the void
            // revive branch below by re-querying.
          }
        }
      }

      // Re-read after potential auto-heal so the rescue branch sees
      // the current state. Cheap (PK lookup) and only fires when an
      // existing row was found above.
      const { data: existingRowFresh } = existingRow ? await supabase
        .from("invoices")
        .select(INVOICE_COLS)
        .eq("org_id", orgId)
        .eq("load_id", load.id)
        .neq("status", "void")
        .maybeSingle() : { data: null };

      if (existingRowFresh) {
        const existingTyped = existingRowFresh as unknown as { id: string; status: string };
        const existingStatus = existingTyped.status;
        if (existingStatus === "draft") {
          // Reuse the existing draft. Refresh snapshot/total/customer
          // so any data corrections (rate edits, broker pick, etc.)
          // since the original draft show up in the packet.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: upd, error: updErr } = await supabase
            .from("invoices")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .update({
              customer_id:     load.customer_id,
              invoice_number:  invoiceNumber,
              total,
              issued_at:       new Date().toISOString(),
              due_at:          dueAt,
              snapshot,
            } as any)
            .eq("id", existingTyped.id)
            .eq("org_id", orgId)
            .eq("status", "draft")
            .select(INVOICE_COLS)
            .single();
          if (updErr || !upd) {
            failed.push({ loadId, error: updErr?.message ?? "rescue_update_failed" });
            continue;
          }
          invoiceRow = upd;
          rescued = true;
        } else {
          // Sent / paid — load was already invoiced; surface that
          // and skip. The accounting page should self-heal the
          // bucket on the next refresh (it groups by invoice.status).
          failed.push({
            loadId,
            error: `Already invoiced (status: ${existingStatus}). Refresh to update the bucket.`,
          });
          continue;
        }
      } else {
        // No active invoice. Check for a void row first — the
        // schema's idx_invoices_number_per_org index is
        // unconditional (void rows keep their number reserved),
        // so a fresh insert with the same invoice_number trips
        // 23505 every time. Reviving the void is semantically
        // identical to a fresh draft and avoids the dead-end UX.
        // This also catches the auto-heal path above where we
        // just voided a stale sent/paid row.
        const { data: voidRows } = await supabase
          .from("invoices")
          .select(INVOICE_COLS)
          .eq("org_id", orgId)
          .eq("load_id", load.id)
          .eq("status", "void")
          .order("issued_at", { ascending: false })
          .limit(1);
        const existingVoid = ((voidRows ?? [])[0] as unknown as InvoiceRow | undefined);

        if (existingVoid) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: rev, error: revErr } = await supabase
            .from("invoices")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .update({
              customer_id:     load.customer_id,
              invoice_number:  invoiceNumber,
              status:          "draft" as InvoiceStatus,
              void_reason:     null,
              total,
              issued_at:       new Date().toISOString(),
              due_at:          dueAt,
              snapshot,
            } as any)
            .eq("id", existingVoid.id)
            .eq("org_id", orgId)
            .eq("status", "void")
            .select(INVOICE_COLS)
            .single();
          if (revErr || !rev) {
            failed.push({ loadId, error: revErr?.message ?? "revive_failed" });
            continue;
          }
          invoiceRow = rev;
        } else {
          // No prior row at all — normal insert path.
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
              // Lost the race with a concurrent insert — rare but
              // possible. Surface a distinct error so logs can tell
              // it apart from the older stale-state case.
              failed.push({ loadId, error: "An active invoice already exists for this load (race)." });
            } else {
              failed.push({ loadId, error: insertErr?.message ?? "insert_failed" });
            }
            continue;
          }
          invoiceRow = data;
        }
      }

      // Always heal billing_status — covers both the fresh-insert
      // case and the rescue case where the prior flip didn't land.
      // setBillingStatus audits the transition iff value actually
      // changed, so the heal-no-op case doesn't pollute the history.
      await setBillingStatus(load.id, orgId, "invoiced", undefined);

      const newInvoice = rowToInvoice(invoiceRow as unknown as InvoiceRow);
      void rescued; // info-only; UI doesn't distinguish today

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
      const { sendInvoiceEmail, loadOrgInvoiceSettings } =
        await import("../lib/invoiceEmail.js");
      const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad, persistInvoicePacket } =
        await import("../lib/invoicePacket.js");
      // Org's subject/body templates — pulled once for every broker
      // group in this batch.
      const orgInvoiceSettings = await loadOrgInvoiceSettings(orgId);

      // Re-read invoices to ensure we have the latest snapshot + customer.
      const { data: rows } = await supabase
        .from("invoices")
        .select(INVOICE_COLS)
        .eq("org_id", orgId)
        .in("id", invoiceIds);
      const invs = ((rows ?? []) as unknown as InvoiceRow[]).map(rowToInvoice);

      // Resolve broker recipient info per invoice. We loop per invoice
      // and send one email each — the broker grouping is gone (see
      // batch-send route header for why).
      const distinctCustomerIds = Array.from(new Set(
        invs.filter(i => i.customerId).map(i => i.customerId!),
      ));
      const { data: customerRows } = await supabase
        .from("customers")
        .select("id,name,invoice_email,invoice_method,invoice_portal")
        .eq("org_id", orgId)
        .in("id", distinctCustomerIds);
      const customerById = new Map<string, {
        name: string;
        invoice_email: string | null;
        invoice_method: string | null;
        invoice_portal: string | null;
      }>();
      for (const row of (customerRows ?? []) as Array<{
        id: string;
        name: string;
        invoice_email: string | null;
        invoice_method: string | null;
        invoice_portal: string | null;
      }>) {
        customerById.set(row.id, {
          name: row.name,
          invoice_email: row.invoice_email,
          invoice_method: row.invoice_method,
          invoice_portal: row.invoice_portal,
        });
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

      // Process invoices in parallel with a small concurrency cap. The
      // packet build (~1.5s) + Resend send (~400ms) dominate per-invoice
      // wall time; running 5 at a time turns a 30-invoice batch from
      // ~60s to ~12s. Cap is small enough to keep memory bounded
      // (each in-flight packet holds ~10-20 MB), respect Resend's
      // ~10 req/sec rate limit, and not flood Supabase Storage.
      type GroupResult = BatchSendInvoicesResponse["groups"][number];
      const processInvoice = async (inv: typeof invs[number]): Promise<GroupResult> => {
        const loadNumber = inv.snapshot.loadNumber || undefined;
        if (!inv.customerId) {
          // Brokerless invoices can't be auto-sent. Surface them in
          // the result so the UI can show "Skipped — no broker on
          // load" instead of silently dropping them — the count
          // mismatch ("9 generated, only 6 sent") was the symptom.
          return {
            customerId: "", brokerName: inv.snapshot.brokerName ?? "Unknown broker",
            to: null, status: "skipped_no_customer", invoiceIds: [inv.id], loadNumber,
            error: "No broker linked to this load — set a customer before sending.",
          };
        }
        const customer = customerById.get(inv.customerId);
        const brokerName = customer?.name ?? inv.snapshot.brokerName ?? "Unknown broker";
        const recipient  = customer?.invoice_email?.trim() || undefined;
        const isPortal   = customer?.invoice_method === "portal";
        const portalLabel = customer?.invoice_portal?.trim() || "portal";

        // Email-mode broker with no AP email saved — skip.
        if (!isPortal && !recipient) {
          return {
            customerId: inv.customerId, brokerName, to: null,
            status: "skipped_no_email", invoiceIds: [inv.id], loadNumber,
          };
        }

        let packet: Buffer;
        try {
          const [extraDocPaths, rateConPath] = await Promise.all([
            attachLoadDocs ? resolvePacketDocsForLoad(inv.loadId, orgId) : Promise.resolve<string[]>([]),
            resolveRateConPathForLoad(inv.loadId, orgId),
          ]);
          const built = await buildInvoicePacket({
            invoice: inv, rateConPath, extraDocPaths,
            issuedDate: fmt(inv.issuedAt), dueDate: fmt(inv.dueAt),
          });
          packet = built.buffer;
        } catch (err) {
          return {
            customerId: inv.customerId, brokerName, to: recipient ?? null, status: "failed",
            invoiceIds: [inv.id], loadNumber,
            error: `packet build failed: ${(err as Error)?.message}`,
          };
        }

        // Portal brokers: skip the broker-bound email, optionally bcc
        // a packet copy to the dispatcher for portal upload, and flip
        // sent_method='portal' so the invoice advances. Email brokers
        // take the normal path. (See batch-send route for the full
        // explanation — kept in sync.)
        let messageId: string | undefined;
        if (isPortal) {
          if (bccSender) {
            try {
              const sendRes = await sendInvoiceEmail({
                invoices:        [inv],
                invoiceSettings: orgInvoiceSettings,
                to:              bccSender,
                bodyText:        body.bodyText,
                attachments: [{
                  filename: `invoice-packet-${inv.invoiceNumber}.pdf`,
                  content:  packet,
                }],
              });
              messageId = sendRes.messageId;
            } catch (err) {
              console.warn("[batch-generate.thenSend] portal bcc-self failed for", inv.invoiceNumber, err);
            }
          }
        } else {
          try {
            const sendRes = await sendInvoiceEmail({
              invoices:        [inv],
              invoiceSettings: orgInvoiceSettings,
              to:              recipient!,
              cc:              body.cc,
              bccSender,
              bodyText:        body.bodyText,
              attachments: [{
                filename: `invoice-packet-${inv.invoiceNumber}.pdf`,
                content:  packet,
              }],
            });
            messageId = sendRes.messageId;
          } catch (err) {
            return {
              customerId: inv.customerId, brokerName, to: recipient!, status: "failed",
              invoiceIds: [inv.id], loadNumber,
              error: (err as Error)?.message ?? "email send failed",
            };
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: upd } = await supabase
          .from("invoices")
          .update({
            status:      "sent",
            sent_at:     new Date().toISOString(),
            sent_to:     isPortal ? portalLabel : recipient!,
            sent_method: isPortal ? "portal" : "email",
          } as any)
          .eq("id", inv.id)
          .eq("org_id", orgId)
          .eq("status", "draft")
          .select(INVOICE_COLS)
          .single();
        if (upd) {
          const sentInv = rowToInvoice(upd as unknown as InvoiceRow);
          try {
            await persistInvoicePacket({ invoice: sentInv, orgId, prebuilt: packet });
          } catch { /* best-effort */ }
        }

        return {
          customerId: inv.customerId, brokerName,
          to:         isPortal ? portalLabel : recipient!,
          status:     isPortal ? "sent_portal" : "sent",
          invoiceIds: [inv.id], loadNumber, messageId,
        };
      };

      res.sent = await pMapWithLimit(invs, 5, processInvoice);
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
// POST /v1/invoices/batch-send — send a set of draft invoices, one email
// per invoice.
// ─────────────────────────────────────────────────────────────────────────
//
// "Batch" here means "send these N drafts in one API call" — NOT "stuff
// them all into one email". Each invoice gets its own outbound email
// addressed to its broker's AP inbox, with that invoice's merged
// packet as the only attachment. This matches how broker AP teams
// actually file invoices (one invoice = one filing record); an
// earlier grouping behaviour where multiple invoices to the same
// broker landed in a single email caused confusion because the
// subject only referenced the first invoice.
//
// Each invoice's send is independent: a Resend failure or missing
// recipient on invoice A doesn't block invoice B. The response
// `groups[]` reports per-invoice outcomes (invoiceIds[] always has
// length 1 — kept as an array to preserve the response shape).

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

  // Resolve broker metadata (name + invoicing fields) for the
  // customers referenced by the resolved-customer-by-invoice map.
  // invoice_method + invoice_portal are needed so portal-mode brokers
  // can advance to "sent" without an email actually leaving the
  // server (the dispatcher uploads to the portal manually).
  const distinctCustomerIds = Array.from(new Set(resolvedCustomerByInvoiceId.values()));
  const { data: customerRows } = await supabase
    .from("customers")
    .select("id,name,invoice_email,invoice_method,invoice_portal")
    .eq("org_id", orgId)
    .in("id", distinctCustomerIds);
  const customerById = new Map<string, {
    name: string;
    invoice_email: string | null;
    invoice_method: string | null;
    invoice_portal: string | null;
  }>();
  for (const row of (customerRows ?? []) as Array<{
    id: string;
    name: string;
    invoice_email: string | null;
    invoice_method: string | null;
    invoice_portal: string | null;
  }>) {
    customerById.set(row.id, {
      name: row.name,
      invoice_email: row.invoice_email,
      invoice_method: row.invoice_method,
      invoice_portal: row.invoice_portal,
    });
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

  const { sendInvoiceEmail, mergeCcList, loadOrgInvoiceSettings } =
    await import("../lib/invoiceEmail.js");
  const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad, persistInvoicePacket } =
    await import("../lib/invoicePacket.js");

  const fmt = (iso?: string) => iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;

  const attachLoadDocs = body.attachLoadDocs ?? true;

  // One DB hit per request — auto-CC + subject/body templates all
  // come from invoice_settings, shared across every broker group.
  const orgInvoiceSettings = await loadOrgInvoiceSettings(orgId);
  const mergedCc = mergeCcList(body.cc, orgInvoiceSettings?.ccEmail);

  // Send ONE email PER INVOICE — not one per broker. A "batch" here
  // means "send these N drafts each as their own email", which matches
  // how brokers actually file invoices (each invoice = one AP envelope
  // = its own search-by-invoice-number record). Grouping all of a
  // broker's invoices into a single email used to be the behaviour;
  // dispatchers found the result confusing because the subject only
  // referenced the first invoice and the rest were silently attached.
  //
  // Each "group" in the response now represents a single invoice's
  // send result. The response shape is preserved (BatchSendInvoicesResponse
  // still keyed by customerId + invoiceIds[]) so the client doesn't
  // need a parallel rewrite — invoiceIds[] just always has length 1.
  // Process invoices in parallel with a small concurrency cap. See the
  // concurrency.ts helper for the trade-off rationale; cap of 5 keeps
  // 5 in-flight packet builds (~50-100MB total) and respects Resend's
  // ~10 req/sec rate limit. A 30-invoice batch goes from ~60s sequential
  // to ~12s parallel.
  type GroupResult = BatchSendInvoicesResponse["groups"][number];
  const processInvoice = async (inv: typeof allInvoices[number]): Promise<GroupResult> => {
    const customerId = resolvedCustomerByInvoiceId.get(inv.id)!;
    const customer   = customerById.get(customerId);
    const brokerName = customer?.name ?? inv.snapshot.brokerName ?? "Unknown broker";
    const recipient  = customer?.invoice_email?.trim() || undefined;
    const loadNumber = inv.snapshot.loadNumber || undefined;
    const isPortal   = customer?.invoice_method === "portal";
    const portalLabel = customer?.invoice_portal?.trim() || "portal";

    // Email-mode broker with no AP email saved — can't send.
    if (!isPortal && !recipient) {
      return {
        customerId,
        brokerName,
        to:         null,
        status:     "skipped_no_email",
        invoiceIds: [inv.id],
        loadNumber,
      };
    }

    // Build the merged packet for THIS invoice only. Same call whether
    // the broker is email or portal — portal-mode still needs the PDF
    // for the bcc-self copy + the persistent archive.
    let packet: Buffer;
    try {
      const [extraDocPaths, rateConPath] = await Promise.all([
        attachLoadDocs ? resolvePacketDocsForLoad(inv.loadId, orgId) : Promise.resolve<string[]>([]),
        resolveRateConPathForLoad(inv.loadId, orgId),
      ]);
      const built = await buildInvoicePacket({
        invoice:     inv,
        rateConPath,
        extraDocPaths,
        issuedDate:  fmt(inv.issuedAt),
        dueDate:     fmt(inv.dueAt),
      });
      // Same partial-packet guard as the single-invoice send. Default:
      // skip this invoice from the batch and report failed; the
      // dispatcher can re-run with allowPartialPacket=true if they
      // know what they're shipping.
      if (built.skipped.length && !body.allowPartialPacket) {
        console.warn("[batch-send] refusing send — packet incomplete:", inv.invoiceNumber, built.skipped);
        return {
          customerId,
          brokerName,
          to:         recipient ?? null,
          status:     "failed",
          invoiceIds: [inv.id],
          loadNumber,
          error:      `packet_incomplete: ${built.skipped.length} selected doc${built.skipped.length === 1 ? "" : "s"} failed to attach — ${built.skipped.map(s => `${s.path} (${s.reason})`).join("; ")}`,
        };
      }
      if (built.skipped.length) {
        console.warn("[batch-send] sending with skipped sources (allowPartialPacket=true):", inv.invoiceNumber, built.skipped);
      }
      packet = built.buffer;
    } catch (err) {
      console.error("[batch-send] packet build failed for", inv.invoiceNumber, err);
      return {
        customerId,
        brokerName,
        to:         recipient ?? null,
        status:     "failed",
        invoiceIds: [inv.id],
        loadNumber,
        error:      `packet build failed: ${(err as Error)?.message}`,
      };
    }

    // Branch on routing mode:
    //   • Email broker: send the packet to recipient + cc + bcc, flip
    //     invoice to sent_method='email'.
    //   • Portal broker: NO email to the broker (they file the
    //     packet via the portal manually). If bccSelf was on, send a
    //     to-self copy so the dispatcher has the packet ready to
    //     upload. Either way, flip invoice to sent_method='portal'
    //     so it advances out of Queued.
    let messageId: string | undefined;
    if (isPortal) {
      // Optional courtesy send-to-self with the packet attached.
      // Treat as best-effort; failure here doesn't block the
      // status-flip — the dispatcher's "I uploaded to the portal"
      // bookkeeping shouldn't depend on the email gateway.
      if (bccSender) {
        try {
          const result = await sendInvoiceEmail({
            invoices:        [inv],
            invoiceSettings: orgInvoiceSettings,
            to:              bccSender,
            bodyText:        body.bodyText,
            attachments: [{
              filename: `invoice-packet-${inv.invoiceNumber}.pdf`,
              content:  packet,
            }],
          });
          messageId = result.messageId;
        } catch (err) {
          console.warn("[batch-send] portal bcc-self failed for", inv.invoiceNumber, err);
        }
      }
    } else {
      // Standard email path — recipient is guaranteed non-null
      // because the early-skip caught the no-email case above.
      try {
        const result = await sendInvoiceEmail({
          invoices:        [inv],
          invoiceSettings: orgInvoiceSettings,
          to:              recipient!,
          cc:              mergedCc.length ? mergedCc : undefined,
          bccSender,
          bodyText:        body.bodyText,
          attachments: [{
            filename: `invoice-packet-${inv.invoiceNumber}.pdf`,
            content:  packet,
          }],
        });
        messageId = result.messageId;
      } catch (err) {
        console.error("[batch-send] email send failed for", inv.invoiceNumber, err);
        return {
          customerId,
          brokerName,
          to:         recipient ?? null,
          status:     "failed",
          invoiceIds: [inv.id],
          loadNumber,
          error:      (err as Error)?.message ?? "email send failed",
        };
      }
    }

    // Flip to sent + archive. If invoice.customer_id was null and we
    // resolved via the load fallback, write the resolved id back so
    // future ops don't need the fallback. Snapshot text (broker name
    // in the PDF) stays as-is for audit integrity.
    const updateRow: Record<string, unknown> = {
      status:      "sent",
      sent_at:     new Date().toISOString(),
      sent_to:     isPortal ? portalLabel : recipient!,
      sent_method: isPortal ? "portal" : "email",
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
    } else {
      const sentInv = rowToInvoice(data as unknown as InvoiceRow);
      try {
        await persistInvoicePacket({ invoice: sentInv, orgId, prebuilt: packet });
      } catch (persistErr) {
        console.warn("[batch-send] packet persistence failed for", sentInv.invoiceNumber, persistErr);
      }
    }

    return {
      customerId,
      brokerName,
      // For portal brokers, the "to" field carries the portal label
      // (e.g. "TriumphPay (https://…)") so the UI shows what the
      // dispatcher needs to upload to. Email brokers carry the AP
      // email as before.
      to:         isPortal ? portalLabel : recipient!,
      status:     isPortal ? "sent_portal" : "sent",
      invoiceIds: [inv.id],
      loadNumber,
      messageId,
    };
  };

  const groups = await pMapWithLimit(allInvoices, 5, processInvoice);
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
  await setBillingStatus(invoice.load_id, orgId, "paid", undefined);

  const res: MarkInvoicePaidResponse = { invoice: rowToInvoice(invoice) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/:id/unmark-paid — paid → sent (payment reversal)
// ─────────────────────────────────────────────────────────────────────────
//
// Reverts a mark-paid: clears paid_at/paid_amount/paid_method/paid_note
// and rolls loads.billing_status back from 'paid' to 'invoiced'. Lands
// the invoice back in 'sent' state since reaching paid required an
// invoice send (mark-paid accepts sent OR draft, but draft → paid
// without a send is rare in practice and still safely lands here as
// "sent" — the operator can re-send if they need a delivery confirm).
// The reason (if any) is appended to paid_note so the audit trail
// preserves WHY the payment was reversed.

invoices.post("/:id/unmark-paid", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<UnmarkInvoicePaidRequest>().catch(() => ({} as UnmarkInvoicePaidRequest));

  const update = {
    status:      "sent",
    paid_at:     null,
    paid_amount: null,
    paid_method: null,
    // Preserve the reversal reason in paid_note for audit / hover.
    // Cleared if no reason supplied so a stale prior note doesn't
    // linger after the reversal.
    paid_note:   body.reason?.trim() ? `Unmarked paid: ${body.reason.trim()}` : null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("invoices")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("status", "paid")   // only reverse from paid
    .select(INVOICE_COLS)
    .single();
  if (error) {
    return c.json({ error: "unmark_paid_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "invalid_state", detail: "invoice is not in paid state" } satisfies ApiErrorResponse, 409);

  // Roll loads.billing_status back to 'invoiced' so the row returns
  // to the Invoiced bucket on the accounting page.
  const invoice = data as unknown as InvoiceRow;
  await setBillingStatus(invoice.load_id, orgId, "invoiced", undefined);

  const res: UnmarkInvoicePaidResponse = { invoice: rowToInvoice(invoice) };
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
  await setBillingStatus(invoice.load_id, orgId, "verified", undefined);

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
//              stuck void by an earlier failed regenerate run.
//   - sent   → implicit void + revive to draft. The broker already
//              has the old packet; the dispatcher clicking Regenerate
//              is explicitly choosing to ship a corrected version.
//              Net effect: same one-row, same invoice_number, status
//              flips sent → draft so the next Send produces a new
//              packet with the latest doc + financial state.
//   - paid   → 409. Money has changed hands; the dispatcher needs to
//              hit Unmark Paid first if they really want to replace
//              the row.
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
  if (existing.status === "paid") {
    return c.json(
      { error: "invalid_state", detail: "cannot regenerate a paid invoice — Unmark Paid first if you need to replace it" } satisfies ApiErrorResponse,
      409,
    );
  }
  const wasVoided = existing.status === "void";
  const wasSent   = existing.status === "sent";
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
  if (wasSent) {
    // The previous packet is already in the broker's inbox; clear the
    // sent_at / sent_to / sent_method markers so the next Send writes
    // fresh ones (and so the UI's "sent" badge goes away while the
    // row is back in draft). The new invoice_number is the same as
    // the old one — brokers reconcile by number, so they'll see the
    // second packet as a correction rather than a new charge.
    updateRow.status      = "draft";
    updateRow.sent_at     = null;
    updateRow.sent_to     = null;
    updateRow.sent_method = null;
  }
  // Acceptable starting states: draft, void, or sent. Paid was rejected above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updatedRow, error: updateErr } = await supabase
    .from("invoices")
    .update(updateRow as any)
    .eq("id", existing.id)
    .eq("org_id", orgId)
    .in("status", ["draft", "void", "sent"])
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
    await setBillingStatus(load.id, orgId, "invoiced", undefined);
  }
  // If we rewound a sent invoice to draft, the load's billing_status
  // was 'invoiced' — that needs to drop back to 'verified' so the
  // closeout/accounting buckets show this load as ready to re-send.
  // The next Send call will flip it back to 'invoiced' on success.
  if (wasSent) {
    await setBillingStatus(load.id, orgId, "verified", undefined);
  }

  const newInvoice = rowToInvoice(updatedRow as unknown as InvoiceRow);

  // 5. Replace the archived packet doc. persistInvoicePacket clears any
  //    prior packet rows for this invoice id automatically before
  //    writing the new one.
  let packetPersistError: string | null = null;
  try {
    const { persistInvoicePacket } = await import("../lib/invoicePacket.js");
    await persistInvoicePacket({ invoice: newInvoice, orgId });
    console.log("[POST /v1/invoices/:id/regenerate] packet rebuilt:", newInvoice.invoiceNumber);
  } catch (err) {
    // Non-fatal for the regenerate call itself (the invoice row is
    // already updated + status flipped). But the dispatcher relies on
    // the rebuilt packet doc showing up in the load's docs panel — a
    // silent persistence failure would make it look like nothing
    // happened. Log loudly so Railway shows the failure mode, and
    // surface it in the response so the client can warn the user.
    packetPersistError = (err as Error)?.message ?? "unknown";
    console.error("[POST /v1/invoices/:id/regenerate] packet persistence FAILED:", newInvoice.invoiceNumber, err);
  }

  const res: CreateInvoiceResponse & { warning?: string } = { invoice: newInvoice };
  if (packetPersistError) {
    res.warning = `Invoice regenerated but the merged packet PDF didn't rebuild: ${packetPersistError}. The invoice itself is fine — try clicking Regenerate again, or contact support if it keeps failing.`;
  }
  return c.json(res, 200);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/batch-resend — resend already-sent invoices
// ─────────────────────────────────────────────────────────────────────────
//
// Same per-invoice loop as batch-send, but operates on status='sent'
// instead of 'draft'. Refreshes sent_at on each successful resend (the
// other sent_* columns stay as they were — recipient could have changed
// in customers, but the snapshot is frozen so we don't try to be clever
// about that here). Status stays 'sent'.
//
// Same templating + per-invoice email + ccEmail merging as batch-send.

invoices.post("/batch-resend", requireCapability("accounting.send_invoice"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const body   = await c.req.json<BatchResendInvoicesRequest>();

  if (!Array.isArray(body?.invoiceIds) || body.invoiceIds.length === 0) {
    return badRequest(c, ["invoiceIds (non-empty array) required"]);
  }
  if (body.invoiceIds.length > 50) {
    return badRequest(c, ["batch limited to 50 invoices per call"]);
  }

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
  const badStatus = allInvoices.find(i => i.status !== "sent");
  if (badStatus) {
    return badRequest(c, [`invoice ${badStatus.invoiceNumber} is ${badStatus.status}; batch-resend only works on sent invoices`]);
  }
  // Resolve customer per invoice (same two-level fallback the send
  // route uses: invoice.customer_id → load.customer_id). A sent invoice
  // SHOULD already have customer_id populated (the send flow writes it
  // back on dispatch) but we keep the fallback defensively.
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
    return badRequest(c, [`invoice(s) ${stillNoBroker.join(", ")} have no linked customer. Open the load and pick a broker from the customer picker.`]);
  }

  const distinctCustomerIds = Array.from(new Set(resolvedCustomerByInvoiceId.values()));
  const { data: customerRows } = await supabase
    .from("customers")
    .select("id,name,invoice_email")
    .eq("org_id", orgId)
    .in("id", distinctCustomerIds);
  const customerById = new Map<string, { name: string; invoice_email: string | null }>();
  for (const row of (customerRows ?? []) as Array<{ id: string; name: string; invoice_email: string | null }>) {
    customerById.set(row.id, { name: row.name, invoice_email: row.invoice_email });
  }

  let bccSender: string | undefined;
  if (body.bccSelf) {
    try {
      const { clerk } = await import("../lib/clerk.js");
      const user = await clerk().users.getUser(userId);
      const primary = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId);
      bccSender = primary?.emailAddress;
    } catch (err) {
      console.warn("[POST /v1/invoices/batch-resend] clerk user lookup failed:", err);
    }
  }

  const { sendInvoiceEmail, mergeCcList, loadOrgInvoiceSettings } =
    await import("../lib/invoiceEmail.js");
  const { buildInvoicePacket, resolvePacketDocsForLoad, resolveRateConPathForLoad, persistInvoicePacket } =
    await import("../lib/invoicePacket.js");

  const fmt = (iso?: string) => iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : undefined;

  const attachLoadDocs = body.attachLoadDocs ?? true;
  const orgInvoiceSettings = await loadOrgInvoiceSettings(orgId);
  const mergedCc = mergeCcList(body.cc, orgInvoiceSettings?.ccEmail);

  const groups: BatchResendInvoicesResponse["groups"] = [];

  for (const inv of allInvoices) {
    const customerId = resolvedCustomerByInvoiceId.get(inv.id)!;
    const customer   = customerById.get(customerId);
    const brokerName = customer?.name ?? inv.snapshot.brokerName ?? "Unknown broker";
    const recipient  = customer?.invoice_email?.trim() || undefined;
    const loadNumber = inv.snapshot.loadNumber || undefined;

    if (!recipient) {
      groups.push({
        customerId, brokerName, to: null,
        status: "skipped_no_email", invoiceIds: [inv.id], loadNumber,
      });
      continue;
    }

    let packet: Buffer;
    try {
      const [extraDocPaths, rateConPath] = await Promise.all([
        attachLoadDocs ? resolvePacketDocsForLoad(inv.loadId, orgId) : Promise.resolve<string[]>([]),
        resolveRateConPathForLoad(inv.loadId, orgId),
      ]);
      const built = await buildInvoicePacket({
        invoice:     inv,
        rateConPath,
        extraDocPaths,
        issuedDate:  fmt(inv.issuedAt),
        dueDate:     fmt(inv.dueAt),
      });
      packet = built.buffer;
    } catch (err) {
      groups.push({
        customerId, brokerName, to: recipient, status: "failed",
        invoiceIds: [inv.id], loadNumber,
        error: `packet build failed: ${(err as Error)?.message}`,
      });
      continue;
    }

    let messageId: string | undefined;
    try {
      const result = await sendInvoiceEmail({
        invoices:        [inv],
        invoiceSettings: orgInvoiceSettings,
        to:              recipient,
        cc:              mergedCc.length ? mergedCc : undefined,
        bccSender,
        bodyText:        body.bodyText,
        attachments: [{
          filename: `invoice-packet-${inv.invoiceNumber}.pdf`,
          content:  packet,
        }],
      });
      messageId = result.messageId;
    } catch (err) {
      groups.push({
        customerId, brokerName, to: recipient, status: "failed",
        invoiceIds: [inv.id], loadNumber,
        error: (err as Error)?.message ?? "email send failed",
      });
      continue;
    }

    // Refresh sent_at (and recipient/method, in case the org's
    // ccEmail or customer's invoice_email has changed since the
    // original send). Status stays 'sent'.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: upd } = await supabase
      .from("invoices")
      .update({
        sent_at:     new Date().toISOString(),
        sent_to:     recipient,
        sent_method: "email",
      } as any)
      .eq("id", inv.id)
      .eq("org_id", orgId)
      .eq("status", "sent")
      .select(INVOICE_COLS)
      .single();
    if (upd) {
      const refreshedInv = rowToInvoice(upd as unknown as InvoiceRow);
      try {
        await persistInvoicePacket({ invoice: refreshedInv, orgId, prebuilt: packet });
      } catch (persistErr) {
        console.warn("[batch-resend] packet re-archive failed for", refreshedInv.invoiceNumber, persistErr);
      }
    }

    groups.push({
      customerId, brokerName, to: recipient, status: "sent",
      invoiceIds: [inv.id], loadNumber, messageId,
    });
  }

  const res: BatchResendInvoicesResponse = { groups };
  return c.json(res);
});

export default invoices;
