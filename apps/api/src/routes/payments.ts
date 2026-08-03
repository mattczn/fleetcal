/**
 * /v1/payments — receivables evidence, and the Receivables page feed.
 *
 *   GET    /v1/payments/proofs                  — list evidence
 *   POST   /v1/payments/proofs                  — record evidence
 *   GET    /v1/payments/proofs/:id              — one proof + what it covered
 *   PATCH  /v1/payments/proofs/:id              — correct evidence
 *   DELETE /v1/payments/proofs/:id              — remove evidence (keeps allocations)
 *   POST   /v1/payments/proofs/:id/attachment   — upload the PDF/image
 *   GET    /v1/payments/proofs/:id/attachment   — signed URL
 *   GET    /v1/payments/receivables             — the whole page in one call
 *
 * A "proof" is evidence money moved — a remittance advice, a bank line,
 * a check. It stands alone: one proof routinely covers a dozen invoices,
 * and evidence can arrive before anyone knows which invoices it settles.
 * Applying it to invoices happens on /v1/invoices/:id/payments, which
 * writes the allocation ledger (see routes/invoices.ts).
 *
 * The allocation endpoints live with the invoice because that's the
 * resource whose state they change; this file owns the evidence side and
 * the read model. Row→domain converters are exported both ways.
 */

import { Hono } from "hono";
import type {
  PaymentProof,
  PaymentProofKind,
  PaymentProofSource,
  InvoicePayment,
  ReceivableInvoice,
  ReceivableCustomerSummary,
  ReceivablesTotals,
  AgingBucket,
  InvoiceStatus,
  ListPaymentProofsResponse,
  GetPaymentProofResponse,
  CreatePaymentProofRequest,
  CreatePaymentProofResponse,
  UpdatePaymentProofRequest,
  UpdatePaymentProofResponse,
  DeletePaymentProofResponse,
  UploadProofAttachmentResponse,
  ListReceivablesResponse,
  GetCustomerReceivablesResponse,
  WeeklyCollection,
  ApiErrorResponse,
} from "@fleetcal/types";
import { agingBucketFor, AGING_BUCKETS } from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { appliedByProof, round2 } from "../lib/invoicePayments.js";
import { fetchAllRows } from "../lib/fetchAllRows.js";
import { extractRemittance } from "../lib/remittanceExtractor.js";
import {
  checkTotals, resolveLines, AUTO_APPLY_THRESHOLD,
  type RemittanceSource,
} from "../lib/remittanceMatcher.js";

// payment_proofs / invoice_payments aren't in the generated Database
// types until the schema is regenerated post-migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

export const PROOF_BUCKET = "payment-proofs";

const PROOF_KINDS: readonly PaymentProofKind[] =
  ["remittance", "bank_transaction", "check", "other"];
const PROOF_SOURCES: readonly PaymentProofSource[] =
  ["manual", "upload", "csv", "email", "api"];

// ── Row shapes + converters ───────────────────────────────────────────

export interface ProofRow {
  id:           string;
  org_id:       string;
  kind:         string;
  source:       string;
  customer_id:  string | null;
  payer_raw:    string | null;
  occurred_on:  string;
  amount:       string | number;
  reference:    string | null;
  storage_path: string | null;
  file_name:    string | null;
  mime_type:    string | null;
  size_bytes:   number | null;
  note:         string | null;
  external_id:  string | null;
  created_at:   string;
  updated_at:   string;
  created_by:   string;
}

export const PROOF_COLS =
  "id,org_id,kind,source,customer_id,payer_raw,occurred_on,amount,reference," +
  "storage_path,file_name,mime_type,size_bytes,note,external_id," +
  "created_at,updated_at,created_by";

export function rowToProof(r: ProofRow, appliedAmount?: number): PaymentProof {
  return {
    id:          r.id,
    orgId:       r.org_id,
    kind:        r.kind as PaymentProofKind,
    source:      r.source as PaymentProofSource,
    customerId:  r.customer_id  ?? undefined,
    payerRaw:    r.payer_raw    ?? undefined,
    occurredOn:  r.occurred_on,
    amount:      Number(r.amount),
    reference:   r.reference    ?? undefined,
    storagePath: r.storage_path ?? undefined,
    fileName:    r.file_name    ?? undefined,
    mimeType:    r.mime_type    ?? undefined,
    sizeBytes:   r.size_bytes   ?? undefined,
    note:        r.note         ?? undefined,
    externalId:  r.external_id  ?? undefined,
    appliedAmount,
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
    createdBy:   r.created_by,
  };
}

export interface PaymentRow {
  id:              string;
  org_id:          string;
  invoice_id:      string;
  proof_id:        string | null;
  amount:          string | number;
  paid_on:         string;
  method:          string | null;
  variance_reason: string | null;
  note:            string | null;
  created_at:      string;
  updated_at:      string;
  created_by:      string;
}

export const PAYMENT_COLS =
  "id,org_id,invoice_id,proof_id,amount,paid_on,method,variance_reason,note," +
  "created_at,updated_at,created_by";

export function rowToPayment(r: PaymentRow, proof?: PaymentProof): InvoicePayment {
  return {
    id:             r.id,
    orgId:          r.org_id,
    invoiceId:      r.invoice_id,
    proofId:        r.proof_id ?? undefined,
    amount:         Number(r.amount),
    paidOn:         r.paid_on,
    method:         (r.method ?? undefined) as InvoicePayment["method"],
    varianceReason: (r.variance_reason ?? undefined) as InvoicePayment["varianceReason"],
    note:           r.note ?? undefined,
    createdAt:      r.created_at,
    updatedAt:      r.updated_at,
    createdBy:      r.created_by,
    proof,
  };
}

// ── Route ─────────────────────────────────────────────────────────────

const payments = new Hono<{ Variables: AuthVariables }>();

// Receivables is its own module and its own capability — a carrier can
// run the invoice pipeline without a collections desk, and collecting
// is a bookkeeping job that needn't belong to whoever sends invoices.
//
// Note what is NOT gated here: the allocation endpoints on
// /v1/invoices/:id/payments stay behind `accounting`. Mark Paid on the
// Billing board writes an allocation, and it has to keep working for an
// org with Receivables switched off. This gate covers the evidence
// surface and the AR read model only.
payments.use("*", requireModule("receivables"), requireCapability("receivables.access"));

// ── Proofs ────────────────────────────────────────────────────────────

payments.get("/proofs", async (c) => {
  const orgId = c.get("orgId");
  const q     = c.req.query();

  const buildQuery = () => {
    let query = supabase
      .from("payment_proofs")
      .select(PROOF_COLS)
      .eq("org_id", orgId);
    if (q.customerId) query = query.eq("customer_id", q.customerId);
    if (q.kind)       query = query.eq("kind", q.kind);
    if (q.from)       query = query.gte("occurred_on", q.from);
    if (q.to)         query = query.lte("occurred_on", q.to);
    return query;
  };

  // Paged rather than limited. `unapplied` filters on the allocation sum,
  // which lives in another table and so can't be a SQL predicate — with a
  // hard .limit() the filter would only ever see the first page, and an
  // older unapplied remittance would be invisible forever. Page the set,
  // then filter, then cap for display.
  let rows: ProofRow[];
  try {
    rows = await fetchAllRows<ProofRow>("proofs", buildQuery);
  } catch (e) {
    console.error("[GET /v1/payments/proofs] failed:", e);
    return c.json({
      error: "fetch_failed",
      detail: e instanceof Error ? e.message : "proof fetch failed",
    } satisfies ApiErrorResponse, 500);
  }

  const applied = await appliedByProof(orgId, rows.map((r) => r.id));
  let proofs    = rows.map((r) => rowToProof(r, applied[r.id] ?? 0));

  if (q.unapplied === "true") {
    proofs = proofs.filter((p) => (p.appliedAmount ?? 0) < p.amount - 0.005);
  }

  // Newest evidence first, then cap.
  proofs.sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
  const cap = Math.min(Number(q.limit) || 200, 1000);
  if (proofs.length > cap) proofs = proofs.slice(0, cap);

  const res: ListPaymentProofsResponse = { proofs };
  return c.json(res);
});

payments.get("/proofs/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data, error } = await supabase
    .from("payment_proofs")
    .select(PROOF_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const applied = await appliedByProof(orgId, [id]);
  const proof   = rowToProof(data as ProofRow, applied[id] ?? 0);

  const { data: allocRows } = await supabase
    .from("invoice_payments")
    .select(`${PAYMENT_COLS},invoices(invoice_number,total)`)
    .eq("org_id", orgId)
    .eq("proof_id", id)
    .order("paid_on", { ascending: false });

  type Joined = PaymentRow & { invoices?: { invoice_number: string; total: number } | null };
  const payments_ = ((allocRows ?? []) as Joined[]).map((r) => ({
    ...rowToPayment(r),
    invoiceNumber: r.invoices?.invoice_number,
    invoiceTotal:  r.invoices?.total,
  }));

  const res: GetPaymentProofResponse = { proof, payments: payments_ };
  return c.json(res);
});

payments.post("/proofs", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");

  let body: CreatePaymentProofRequest;
  try { body = await c.req.json<CreatePaymentProofRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["body must be JSON"] } satisfies ApiErrorResponse, 400); }

  const errors: string[] = [];
  if (!PROOF_KINDS.includes(body.kind)) {
    errors.push(`kind must be one of ${PROOF_KINDS.join("|")}`);
  }
  const source = body.source ?? "manual";
  if (!PROOF_SOURCES.includes(source)) {
    errors.push(`source must be one of ${PROOF_SOURCES.join("|")}`);
  }
  if (!body.occurredOn || !/^\d{4}-\d{2}-\d{2}$/.test(body.occurredOn)) {
    errors.push("occurredOn must be YYYY-MM-DD");
  }
  if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount === 0) {
    errors.push("amount must be a non-zero number");
  }
  // Automated sources must be idempotent — without an externalId a
  // re-run of an importer silently duplicates every proof.
  if (source !== "manual" && source !== "upload" && !body.externalId?.trim()) {
    errors.push("externalId is required for csv/email/api sources");
  }
  if (errors.length) {
    return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("payment_proofs")
    .insert({
      org_id:      orgId,
      kind:        body.kind,
      source,
      customer_id: body.customerId?.trim() || null,
      payer_raw:   body.payerRaw?.trim()   || null,
      occurred_on: body.occurredOn,
      amount:      round2(body.amount),
      reference:   body.reference?.trim()  || null,
      note:        body.note?.trim()       || null,
      external_id: body.externalId?.trim() || null,
      created_by:  userId,
    })
    .select(PROOF_COLS)
    .single();

  if (error) {
    // 23505 = the (org, source, external_id) partial unique index. An
    // importer replaying an overlapping window is expected, not an
    // error — hand back the row it already created.
    if ((error as { code?: string }).code === "23505" && body.externalId) {
      const { data: existing } = await supabase
        .from("payment_proofs")
        .select(PROOF_COLS)
        .eq("org_id", orgId)
        .eq("source", source)
        .eq("external_id", body.externalId.trim())
        .maybeSingle();
      if (existing) {
        const res: CreatePaymentProofResponse = { proof: rowToProof(existing as ProofRow, 0) };
        return c.json(res, 200);
      }
    }
    console.error("[POST /v1/payments/proofs] failed:", error);
    return c.json({ error: "insert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const res: CreatePaymentProofResponse = { proof: rowToProof(data as ProofRow, 0) };
  return c.json(res, 201);
});

payments.patch("/proofs/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  let body: UpdatePaymentProofRequest;
  try { body = await c.req.json<UpdatePaymentProofRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["body must be JSON"] } satisfies ApiErrorResponse, 400); }

  const patch: Record<string, unknown> = {};
  if (body.kind !== undefined) {
    if (!PROOF_KINDS.includes(body.kind)) {
      return c.json({ error: "validation_failed", errors: [`kind must be one of ${PROOF_KINDS.join("|")}`] } satisfies ApiErrorResponse, 400);
    }
    patch.kind = body.kind;
  }
  // `null` clears, `undefined` leaves alone — the distinction matters for
  // unlinking a wrongly-assigned customer.
  if (body.customerId !== undefined) patch.customer_id = body.customerId || null;
  if (body.payerRaw   !== undefined) patch.payer_raw   = body.payerRaw   || null;
  if (body.reference  !== undefined) patch.reference   = body.reference  || null;
  if (body.note       !== undefined) patch.note        = body.note       || null;
  if (body.occurredOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.occurredOn)) {
      return c.json({ error: "validation_failed", errors: ["occurredOn must be YYYY-MM-DD"] } satisfies ApiErrorResponse, 400);
    }
    patch.occurred_on = body.occurredOn;
  }
  if (body.amount !== undefined) {
    if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount === 0) {
      return c.json({ error: "validation_failed", errors: ["amount must be a non-zero number"] } satisfies ApiErrorResponse, 400);
    }
    patch.amount = round2(body.amount);
  }
  if (!Object.keys(patch).length) {
    return c.json({ error: "validation_failed", errors: ["no fields to update"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("payment_proofs")
    .update(patch)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(PROOF_COLS)
    .maybeSingle();
  if (error) {
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const applied = await appliedByProof(orgId, [id]);
  const res: UpdatePaymentProofResponse = { proof: rowToProof(data as ProofRow, applied[id] ?? 0) };
  return c.json(res);
});

payments.delete("/proofs/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data: existing } = await supabase
    .from("payment_proofs")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  // Count what's about to be orphaned so the caller can warn. The FK is
  // ON DELETE SET NULL by design: deleting a mis-entered remittance must
  // not erase the record that money arrived.
  const { count } = await supabase
    .from("invoice_payments")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("proof_id", id);

  const { error } = await supabase
    .from("payment_proofs")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/payments/proofs/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const path = (existing as { storage_path: string | null }).storage_path;
  if (path) void supabase.storage.from(PROOF_BUCKET).remove([path]);

  const res: DeletePaymentProofResponse = { ok: true, unlinkedPayments: count ?? 0 };
  return c.json(res);
});

// ── Attachment ────────────────────────────────────────────────────────

payments.post("/proofs/:id/attachment", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data: proofRow } = await supabase
    .from("payment_proofs")
    .select("id,storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!proofRow) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  let body: { file?: File | string };
  try { body = await c.req.parseBody() as typeof body; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] } satisfies ApiErrorResponse, 400); }

  const file = body.file;
  if (!file || typeof file === "string") {
    return c.json({ error: "validation_failed", errors: ["file required"] } satisfies ApiErrorResponse, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime  = file.type || "application/octet-stream";
  const ext   = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand  = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${rand}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(PROOF_BUCKET)
    .upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (upErr) {
    console.error("[POST /v1/payments/proofs/:id/attachment] storage:", upErr);
    return c.json({ error: "upload_failed", detail: upErr.message } satisfies ApiErrorResponse, 500);
  }

  const { data, error } = await supabase
    .from("payment_proofs")
    .update({
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    mime,
      size_bytes:   bytes.length,
    })
    .eq("id", id)
    .eq("org_id", orgId)
    .select(PROOF_COLS)
    .single();
  if (error || !data) {
    void supabase.storage.from(PROOF_BUCKET).remove([storagePath]);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }

  // Replacing an attachment: drop the old blob only after the row
  // points at the new one, so a storage failure can't leave the proof
  // referencing nothing.
  const prior = (proofRow as { storage_path: string | null }).storage_path;
  if (prior && prior !== storagePath) {
    void supabase.storage.from(PROOF_BUCKET).remove([prior]);
  }

  const applied = await appliedByProof(orgId, [id]);
  const res: UploadProofAttachmentResponse = { proof: rowToProof(data as ProofRow, applied[id] ?? 0) };
  return c.json(res);
});

payments.get("/proofs/:id/attachment", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data } = await supabase
    .from("payment_proofs")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const path = (data as { storage_path: string | null } | null)?.storage_path;
  if (!path) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const { data: signed } = await supabase.storage
    .from(PROOF_BUCKET)
    .createSignedUrl(path, 3600);
  if (!signed) return c.json({ error: "sign_failed" } satisfies ApiErrorResponse, 500);
  return c.json({ url: signed.signedUrl });
});

// ── Receivables read model ────────────────────────────────────────────

interface ReceivableInvoiceRow {
  id:             string;
  invoice_number: string;
  status:         string;
  total:          number | null;
  issued_at:      string;
  due_at:         string | null;
  customer_id:    string | null;
  load_id:        string;
  loads?: {
    internal_load_id: number | null;
    load_num:         string | null;
    events?: { id: string; title: string | null; leg_index: number | null; start: string | null }[] | null;
  } | null;
  customers?: { name: string | null } | null;
}

/** Lowest-leg-index event for a load — the pickup leg on a relay, and
 *  the only leg otherwise. Its title labels the load, and its id is what
 *  the calendar's EventModal opens on. */
function pickupLeg(r: ReceivableInvoiceRow) {
  const legs = r.loads?.events ?? [];
  if (!legs.length) return undefined;
  return [...legs].sort((a, b) => (a.leg_index ?? 0) - (b.leg_index ?? 0))[0];
}

/** Whole days between `due` and today, positive when past due. Both
 *  sides are floored to UTC midnight so the count doesn't wobble with
 *  the time of day the page is loaded. */
function daysPastDue(due: string | null, today: number): number | null {
  if (!due) return null;
  const dueMs = Date.parse(due.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(dueMs)) return null;
  return Math.floor((today - dueMs) / 86_400_000);
}


type AllocSummary = { amount: number; paidOn: string; hasProof: boolean };

/** Every allocation for the given invoices, keyed by invoice id.
 *
 *  One query set rather than per-invoice: AR lists run into the hundreds
 *  and N+1 here would dominate the request. Chunked because PostgREST
 *  builds `in.(...)` into the URL and a few thousand uuids blows past the
 *  request-line limit; paged within each chunk because 300 invoices can
 *  carry more than 1000 allocations between them once partial payments
 *  are in play. */
async function allocationsFor(
  orgId: string, invoiceIds: string[],
): Promise<Map<string, AllocSummary[]>> {
  const out = new Map<string, AllocSummary[]>();
  if (!invoiceIds.length) return out;
  type AllocRow = {
    id: string; invoice_id: string; amount: string | number;
    paid_on: string; proof_id: string | null;
  };
  for (let i = 0; i < invoiceIds.length; i += 300) {
    const slice = invoiceIds.slice(i, i + 300);
    const allocs = await fetchAllRows<AllocRow>(
      "receivables/allocations",
      () => supabase
        .from("invoice_payments")
        .select("id,invoice_id,amount,paid_on,proof_id")
        .eq("org_id", orgId)
        .in("invoice_id", slice),
    );
    for (const a of allocs) {
      const list = out.get(a.invoice_id) ?? [];
      list.push({ amount: Number(a.amount), paidOn: a.paid_on, hasProof: a.proof_id !== null });
      out.set(a.invoice_id, list);
    }
  }
  return out;
}

/** Project a joined invoice row + its allocations into the shape both
 *  the ledger and the customer view render. Single implementation so the
 *  Age column can't say one thing on one page and another elsewhere. */
function toReceivableInvoice(
  r: ReceivableInvoiceRow, allocs: AllocSummary[], today: number,
): ReceivableInvoice {
  const total      = Number(r.total ?? 0);
  const paidAmount = round2(allocs.reduce((s, a) => s + a.amount, 0));
  const lastPaidOn = allocs.length
    ? allocs.reduce((a, b) => (a.paidOn >= b.paidOn ? a : b)).paidOn
    : undefined;
  const leg = pickupLeg(r);
  return {
    id:             r.id,
    invoiceNumber:  r.invoice_number,
    status:         r.status as InvoiceStatus,
    loadId:         r.load_id,
    internalLoadId: r.loads?.internal_load_id ?? undefined,
    loadNum:        r.loads?.load_num ?? undefined,
    title:          leg?.title ?? undefined,
    pickupAt:       leg?.start ?? undefined,
    pickupEventId:  leg?.id,
    customerId:     r.customer_id ?? undefined,
    customerName:   r.customers?.name ?? undefined,
    total,
    issuedAt:       r.issued_at,
    dueAt:          r.due_at ?? undefined,
    paidAmount,
    balance:        round2(total - paidAmount),
    agingDays:      daysPastDue(r.due_at, today),
    paymentCount:   allocs.length,
    lastPaidOn,
    hasProof:       allocs.some((a) => a.hasProof),
  };
}

const RECEIVABLE_INVOICE_COLS =
  "id,invoice_number,status,total,issued_at,due_at,customer_id,load_id," +
  "loads(internal_load_id,load_num,events(id,title,leg_index,start)),customers(name)";

payments.get("/receivables", async (c) => {
  const orgId = c.get("orgId");
  const q     = c.req.query();
  const scope = (q.scope === "paid" || q.scope === "all") ? q.scope : "open";

  // Void invoices are never receivable — no money is expected. Draft is
  // included because an issued-but-unsent invoice is still money owed
  // that the operator wants to see aging.
  //
  // Paged, not limited: PostgREST caps responses at 1000 rows in silence,
  // so a `.limit(5000)` reads as working while quietly dropping every
  // invoice past the first thousand — and since the tiles and the rail
  // are summed from these rows, a truncated fetch produces a confidently
  // wrong Outstanding total. The full set is the point.
  //
  // `scope` and `search` define the working set, so they narrow in SQL.
  // `customerId` and `bucket` are selections WITHIN that set and are
  // applied after the rail and tiles are computed — otherwise picking a
  // customer would collapse the rail to the one customer you already
  // picked, and clicking an aging tile would rewrite the tiles.
  const buildInvoiceQuery = () => {
    let query = supabase
      .from("invoices")
      .select(RECEIVABLE_INVOICE_COLS)
      .eq("org_id", orgId)
      .neq("status", "void");
    if (scope === "open") query = query.in("status", ["draft", "sent"]);
    if (scope === "paid") query = query.eq("status", "paid");
    if (q.search?.trim()) query = query.ilike("invoice_number", `%${q.search.trim()}%`);
    return query;
  };

  let invRows: ReceivableInvoiceRow[];
  try {
    invRows = await fetchAllRows<ReceivableInvoiceRow>("receivables/invoices", buildInvoiceQuery);
  } catch (e) {
    console.error("[GET /v1/payments/receivables] failed:", e);
    return c.json({
      error: "fetch_failed",
      detail: e instanceof Error ? e.message : "invoice fetch failed",
    } satisfies ApiErrorResponse, 500);
  }

  const allocByInvoice = await allocationsFor(orgId, invRows.map((r) => r.id));

  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

  const invoices: ReceivableInvoice[] = invRows.map(
    (r) => toReceivableInvoice(r, allocByInvoice.get(r.id) ?? [], today),
  );

  // fetchAllRows pages by id, so restore a sensible default order here.
  // The table re-sorts client-side, but the payload shouldn't arrive in
  // uuid order.
  invoices.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));

  // ── Per-customer rail ───────────────────────────────────────────────
  // Built from the same rows the table renders, so the rail and the
  // table can never disagree. Note the consequence: with scope=open the
  // rail shows open balances only, which is what the rail is for.
  // Terms are read off the invoices rather than a stored customer field:
  // the invoice is the record of what terms were actually written, and
  // `customers` has no structured terms column (only free-text
  // invoice_instructions). Collected per customer, then reduced to the
  // most common gap — a one-off net-15 rush load shouldn't restate a
  // net-30 broker.
  const termGaps = new Map<string, number[]>();

  const custMap = new Map<string, ReceivableCustomerSummary>();
  for (const inv of invoices) {
    const key = inv.customerId ?? "__none__";
    const cur = custMap.get(key) ?? {
      customerId:     inv.customerId ?? null,
      customerName:   inv.customerName ?? "No customer",
      openCount:      0,
      openBalance:    0,
      overdueCount:   0,
      overdueBalance: 0,
      byBucket:       { current: 0, d1_30: 0, d31_plus: 0 },
      oldestAgingDays: null,
    };
    const open = inv.balance > 0.005;
    if (open) {
      cur.openCount   += 1;
      cur.openBalance  = round2(cur.openBalance + inv.balance);
      const b = agingBucketFor(inv.agingDays);
      cur.byBucket[b] = round2(cur.byBucket[b] + inv.balance);
      if (inv.agingDays !== null && inv.agingDays > 0) {
        cur.overdueCount   += 1;
        cur.overdueBalance  = round2(cur.overdueBalance + inv.balance);
      }
      // "Oldest" means most days past due among what's still owed, so
      // only open invoices count — a settled 90-day-old invoice isn't a
      // collections problem anymore.
      if (inv.agingDays !== null &&
          (cur.oldestAgingDays === null || inv.agingDays > cur.oldestAgingDays)) {
        cur.oldestAgingDays = inv.agingDays;
      }
    }
    if (inv.dueAt) {
      const gap = Math.round(
        (Date.parse(inv.dueAt) - Date.parse(inv.issuedAt)) / 86_400_000,
      );
      if (Number.isFinite(gap) && gap > 0 && gap <= 180) {
        const list = termGaps.get(key) ?? [];
        list.push(gap);
        termGaps.set(key, list);
      }
    }
    if (inv.lastPaidOn && (!cur.lastPaidOn || inv.lastPaidOn > cur.lastPaidOn)) {
      cur.lastPaidOn = inv.lastPaidOn;
    }
    custMap.set(key, cur);
  }

  // ── Payment behaviour ───────────────────────────────────────────────
  // "Pays in 41d on average" needs settled invoices, which the default
  // scope=open fetch deliberately excludes — so it's its own bounded
  // read: the last year of paid invoices, issue date to settle date.
  // paid_at is maintained by recomputeInvoicePaid, so this needs no
  // allocation join.
  const behaviourSince = new Date(Date.now() - 365 * 86_400_000).toISOString();
  try {
    const paidRows = await fetchAllRows<{
      id: string; customer_id: string | null; issued_at: string; paid_at: string | null;
    }>("receivables/behaviour", () => supabase
      .from("invoices")
      .select("id,customer_id,issued_at,paid_at")
      .eq("org_id", orgId)
      .eq("status", "paid")
      .gte("paid_at", behaviourSince));

    const daysByCustomer = new Map<string, number[]>();
    for (const r of paidRows) {
      if (!r.paid_at) continue;
      const d = Math.round((Date.parse(r.paid_at) - Date.parse(r.issued_at)) / 86_400_000);
      // Guard against clock skew and backfilled history landing a
      // negative or absurd figure in front of the operator.
      if (!Number.isFinite(d) || d < 0 || d > 365) continue;
      const key = r.customer_id ?? "__none__";
      const list = daysByCustomer.get(key) ?? [];
      list.push(d);
      daysByCustomer.set(key, list);
    }
    for (const [key, days] of daysByCustomer) {
      const cur = custMap.get(key);
      if (!cur || !days.length) continue;
      cur.avgDaysToPay = Math.round(days.reduce((s, d) => s + d, 0) / days.length);
    }
  } catch (e) {
    // Non-fatal: the behaviour line is Detail-density garnish, not the
    // reason anyone opened this page.
    console.warn("[receivables] payment-behaviour rollup skipped:", e);
  }

  // Terms = the mode of the observed gaps, not the mean: brokers write
  // round terms (15/30/45) and averaging a net-30 book with one net-15
  // yields a meaningless "net 29".
  for (const [key, gaps] of termGaps) {
    const cur = custMap.get(key);
    if (!cur || !gaps.length) continue;
    const freq = new Map<number, number>();
    for (const g of gaps) freq.set(g, (freq.get(g) ?? 0) + 1);
    let best = gaps[0], bestN = 0;
    for (const [g, n] of freq) {
      if (n > bestN || (n === bestN && g < best)) { best = g; bestN = n; }
    }
    cur.termsDays = best;
  }

  const customers = [...custMap.values()]
    .sort((a, b) => b.openBalance - a.openBalance || a.customerName.localeCompare(b.customerName));

  // ── Totals ──────────────────────────────────────────────────────────
  const byBucket = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, { count: 0, balance: 0 }]),
  ) as Record<AgingBucket, { count: number; balance: number }>;

  let openCount = 0, openBalance = 0, overdueCount = 0, overdueBalance = 0;
  let unbackedPaidCount = 0;

  for (const inv of invoices) {
    if (inv.balance > 0.005) {
      openCount   += 1;
      openBalance  = round2(openBalance + inv.balance);
      const bucket = agingBucketFor(inv.agingDays);
      byBucket[bucket].count   += 1;
      byBucket[bucket].balance  = round2(byBucket[bucket].balance + inv.balance);
      if (inv.agingDays !== null && inv.agingDays > 0) {
        overdueCount   += 1;
        overdueBalance  = round2(overdueBalance + inv.balance);
      }
    }
    if (inv.status === "paid" && !inv.hasProof) unbackedPaidCount += 1;
  }

  // Collections velocity is a question about payments, not invoices, so
  // it reads the ledger directly — an invoice paid this month may have
  // been issued long before the window.
  // Paged for the same reason as the invoice fetch: a busy month can
  // clear 1000 allocations, and a silently-truncated sum here would
  // under-report collections without looking broken.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const recent = await fetchAllRows<{ id: string; amount: string | number }>(
    "receivables/collected30d",
    () => supabase
      .from("invoice_payments")
      .select("id,amount")
      .eq("org_id", orgId)
      .gte("paid_on", since),
  );
  const collected30d = round2(recent.reduce((s, r) => s + Number(r.amount), 0));

  const totals: ReceivablesTotals = {
    openCount, openBalance, overdueCount, overdueBalance,
    collected30d, byBucket, unbackedPaidCount,
  };

  // Selections, applied last — see the note on the query builder above.
  let filtered = invoices;
  if (q.customerId) {
    filtered = filtered.filter((i) => (i.customerId ?? "__none__") === q.customerId);
  }
  const bucket = q.bucket as AgingBucket | undefined;
  if (bucket && (AGING_BUCKETS as readonly string[]).includes(bucket)) {
    filtered = filtered.filter((i) => i.balance > 0.005 && agingBucketFor(i.agingDays) === bucket);
  }

  const res: ListReceivablesResponse = { invoices: filtered, customers, totals };
  return c.json(res);
});


// ── Customer view ─────────────────────────────────────────────────────
//
// GET /v1/payments/receivables/:customerId
//
// Everything one broker's page renders, in one call. Aging, average
// days-to-pay and the weekly series are all computed here rather than in
// the client: the number an operator chases a broker over shouldn't
// depend on which page they read it from.

const NO_CUSTOMER = "__none__";

payments.get("/receivables/:customerId", async (c) => {
  const orgId      = c.get("orgId");
  const customerId = c.req.param("customerId");
  const q          = c.req.query();
  const scope      = (q.scope === "paid" || q.scope === "all") ? q.scope : "open";
  const isNone     = customerId === NO_CUSTOMER;

  // ── Invoices ────────────────────────────────────────────────────────
  const buildQuery = () => {
    let query = supabase
      .from("invoices")
      .select(RECEIVABLE_INVOICE_COLS)
      .eq("org_id", orgId)
      .neq("status", "void");
    query = isNone ? query.is("customer_id", null) : query.eq("customer_id", customerId);
    if (scope === "open") query = query.in("status", ["draft", "sent"]);
    if (scope === "paid") query = query.eq("status", "paid");
    return query;
  };

  let invRows: ReceivableInvoiceRow[];
  try {
    invRows = await fetchAllRows<ReceivableInvoiceRow>("customer/invoices", buildQuery);
  } catch (e) {
    console.error("[GET /v1/payments/receivables/:customerId] failed:", e);
    return c.json({
      error: "fetch_failed",
      detail: e instanceof Error ? e.message : "invoice fetch failed",
    } satisfies ApiErrorResponse, 500);
  }

  const allocByInvoice = await allocationsFor(orgId, invRows.map((r) => r.id));
  const today    = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const invoices = invRows
    .map((r) => toReceivableInvoice(r, allocByInvoice.get(r.id) ?? [], today))
    .sort((a, b) => (b.agingDays ?? -99999) - (a.agingDays ?? -99999));

  // ── Identity ────────────────────────────────────────────────────────
  let name = "No customer";
  let mcNum: string | undefined;
  let invoiceEmail: string | undefined;
  let invoicePortal: string | undefined;
  let contactPhone: string | undefined;
  let billingAddress: string | undefined;
  let billingNotes: string | undefined;
  let invoiceMethod: "email" | "portal" | undefined;
  if (!isNone) {
    const { data: cust } = await supabase
      .from("customers")
      .select("id,name,mc_num,invoice_method,invoice_email,invoice_portal,contact_phone,billing_address,invoice_instructions")
      .eq("id", customerId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!cust) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
    const row = cust as {
      name: string | null; mc_num: string | null;
      invoice_method: string | null; invoice_email: string | null;
      invoice_portal: string | null; contact_phone: string | null;
      billing_address: string | null; invoice_instructions: string | null;
    };
    name          = row.name ?? "Unnamed customer";
    mcNum         = row.mc_num         ?? undefined;
    invoiceEmail  = row.invoice_email  ?? undefined;
    invoicePortal = row.invoice_portal ?? undefined;
    contactPhone  = row.contact_phone  ?? undefined;
    billingAddress = row.billing_address ?? undefined;
    billingNotes   = row.invoice_instructions ?? undefined;
    invoiceMethod  = row.invoice_method === "portal" ? "portal"
                   : row.invoice_method === "email"  ? "email" : undefined;
  }

  // Lifetime loads — head-only count, no rows pulled over the wire.
  let lifetimeLoads: number | undefined;
  try {
    let lq = supabase.from("loads").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    lq = isNone ? lq.is("customer_id", null) : lq.eq("customer_id", customerId);
    const { count } = await lq;
    lifetimeLoads = count ?? undefined;
  } catch { /* non-fatal — the meta row just omits it */ }

  // ── Rollup ──────────────────────────────────────────────────────────
  // Same shape and same arithmetic as a ledger row.
  const summary: ReceivableCustomerSummary = {
    customerId:      isNone ? null : customerId,
    customerName:    name,
    openCount:       0,
    openBalance:     0,
    overdueCount:    0,
    overdueBalance:  0,
    byBucket:        { current: 0, d1_30: 0, d31_plus: 0 },
    oldestAgingDays: null,
  };
  const gaps: number[] = [];
  for (const inv of invoices) {
    if (inv.balance > 0.005) {
      summary.openCount  += 1;
      summary.openBalance = round2(summary.openBalance + inv.balance);
      const b = agingBucketFor(inv.agingDays);
      summary.byBucket[b] = round2(summary.byBucket[b] + inv.balance);
      if (inv.agingDays !== null && inv.agingDays > 0) {
        summary.overdueCount  += 1;
        summary.overdueBalance = round2(summary.overdueBalance + inv.balance);
      }
      if (inv.agingDays !== null &&
          (summary.oldestAgingDays === null || inv.agingDays > summary.oldestAgingDays)) {
        summary.oldestAgingDays = inv.agingDays;
      }
    }
    if (inv.dueAt) {
      const g = Math.round((Date.parse(inv.dueAt) - Date.parse(inv.issuedAt)) / 86_400_000);
      if (Number.isFinite(g) && g > 0 && g <= 180) gaps.push(g);
    }
    if (inv.lastPaidOn && (!summary.lastPaidOn || inv.lastPaidOn > summary.lastPaidOn)) {
      summary.lastPaidOn = inv.lastPaidOn;
    }
  }
  if (gaps.length) {
    const freq = new Map<number, number>();
    for (const g of gaps) freq.set(g, (freq.get(g) ?? 0) + 1);
    let best = gaps[0], bestN = 0;
    for (const [g, n] of freq) if (n > bestN || (n === bestN && g < best)) { best = g; bestN = n; }
    summary.termsDays = best;
  }

  // ── Behaviour + collections ─────────────────────────────────────────
  // Both read paid invoices, which scope=open excludes by definition, so
  // they get their own bounded query.
  const sinceYear = new Date(Date.now() - 365 * 86_400_000).toISOString();
  try {
    let bq = supabase
      .from("invoices")
      .select("id,issued_at,paid_at")
      .eq("org_id", orgId)
      .eq("status", "paid")
      .gte("paid_at", sinceYear);
    bq = isNone ? bq.is("customer_id", null) : bq.eq("customer_id", customerId);
    const paidRows = await fetchAllRows<{ id: string; issued_at: string; paid_at: string | null }>(
      "customer/behaviour", () => bq);
    const days: number[] = [];
    for (const r of paidRows) {
      if (!r.paid_at) continue;
      const d = Math.round((Date.parse(r.paid_at) - Date.parse(r.issued_at)) / 86_400_000);
      if (Number.isFinite(d) && d >= 0 && d <= 365) days.push(d);
    }
    if (days.length) {
      summary.avgDaysToPay = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
    }
  } catch (e) {
    console.warn("[customer receivables] behaviour rollup skipped:", e);
  }

  // Allocations drive both the 90-day figure and the weekly chart — the
  // ledger is the record of when money actually arrived, which is not
  // the same question as when an invoice was issued.
  let paid90d = 0, paid90dCount = 0;
  const weekTotals = new Map<string, { amount: number; count: number }>();
  try {
    const since12w = mondayOf(new Date(Date.now() - 84 * 86_400_000));
    const since90d = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const earliest = since12w < since90d ? since12w : since90d;

    // Embedded !inner filter keeps the customer scoping in SQL rather
    // than pulling every allocation in the org back to filter here.
    let pq = supabase
      .from("invoice_payments")
      .select("id,amount,paid_on,invoices!inner(customer_id)")
      .eq("org_id", orgId)
      .gte("paid_on", earliest);
    pq = isNone
      ? pq.is("invoices.customer_id", null)
      : pq.eq("invoices.customer_id", customerId);

    const rows = await fetchAllRows<{ id: string; amount: string | number; paid_on: string }>(
      "customer/collections", () => pq);

    for (const r of rows) {
      const amt = Number(r.amount);
      if (r.paid_on >= since90d) { paid90d = round2(paid90d + amt); paid90dCount += 1; }
      if (r.paid_on >= since12w) {
        const wk  = mondayOf(new Date(r.paid_on + "T12:00:00Z"));
        const cur = weekTotals.get(wk) ?? { amount: 0, count: 0 };
        cur.amount = round2(cur.amount + amt);
        cur.count += 1;
        weekTotals.set(wk, cur);
      }
    }
  } catch (e) {
    console.warn("[customer receivables] collections rollup skipped:", e);
  }

  // Emit all 12 weeks including empties — a gap week should render as a
  // flat bar, not shift the chart's other bars sideways.
  const weekly: WeeklyCollection[] = [];
  const firstMonday = mondayOf(new Date(Date.now() - 77 * 86_400_000));
  for (let i = 0; i < 12; i++) {
    const wk = new Date(Date.parse(firstMonday + "T00:00:00Z") + i * 7 * 86_400_000)
      .toISOString().slice(0, 10);
    const cell = weekTotals.get(wk);
    weekly.push({ weekStart: wk, amount: cell?.amount ?? 0, count: cell?.count ?? 0 });
  }

  const res: GetCustomerReceivablesResponse = {
    customer: {
      customerId: isNone ? null : customerId,
      customerName: name,
      mcNum, contactPhone, lifetimeLoads,
      invoiceMethod, invoiceEmail, invoicePortal, billingAddress, billingNotes,
      summary, paid90d, paid90dCount, weekly, invoices,
    },
  };
  return c.json(res);
});

/** ISO date of the Monday on or before `d`. Weeks are Monday-anchored so
 *  a week's bar covers one working week rather than straddling two. */
function mondayOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7;   // Mon = 0
  t.setUTCDate(t.getUTCDate() - dow);
  return t.toISOString().slice(0, 10);
}

// ── Parse an uploaded payment document ────────────────────────────────
//
// Drives the "Apply a payment" workflow: the operator uploads whatever the
// payer sent, and this returns a PROPOSAL — who paid, how much, and which
// open invoices the document points at — for them to confirm.
//
// Writes nothing. The confirm step reuses the existing proof + allocation
// endpoints, so there is exactly one code path that moves money and it is
// the one already in production behind Mark Paid.

/** Map an upload to the medium the extractor reads. Content type is a hint;
 *  the extension wins because browsers routinely send text/csv as
 *  application/octet-stream (and vice versa). */
function mediumFor(filename: string, mimeType: string): RemittanceSource | null {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (ext === "pdf"  || mimeType === "application/pdf")  return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext) || mimeType.startsWith("image/")) {
    return "image";
  }
  if (ext === "csv"  || mimeType === "text/csv")         return "csv";
  if (ext === "txt"  || ext === "eml" || mimeType.startsWith("text/")) return "email_body";
  if (ext === "xlsx" || ext === "xls") return "spreadsheet";
  return null;
}

/** Claude accepts these four; anything else has to be converted first. */
function imageMediaType(filename: string, mimeType: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (mimeType.startsWith("image/") && mimeType !== "image/*") return mimeType;
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif")  return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

payments.post("/parse", async (c) => {
  const orgId = c.get("orgId");

  let body: {
    filename?: string; mimeType?: string; dataBase64?: string; customerId?: string | null;
  };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["body must be JSON"] } satisfies ApiErrorResponse, 400); }

  const filename = (body.filename ?? "").trim();
  const b64      = (body.dataBase64 ?? "").trim();
  if (!b64) {
    return c.json({ error: "validation_failed", errors: ["dataBase64 is required"] } satisfies ApiErrorResponse, 400);
  }

  const medium = mediumFor(filename, body.mimeType ?? "");
  if (!medium) {
    return c.json({
      error: "validation_failed",
      errors: [`unsupported file type "${filename}" — upload a PDF, image, CSV, or text file`],
    } satisfies ApiErrorResponse, 400);
  }
  if (medium === "spreadsheet") {
    // .xlsx is a zip archive; neither the model nor this route can read it as
    // a document. Say so plainly rather than failing in a confusing way.
    return c.json({
      error: "validation_failed",
      errors: ["Excel files can't be read directly yet — export the sheet as CSV and upload that"],
    } satisfies ApiErrorResponse, 400);
  }

  // PDFs and images go to the model as base64; the rest is decoded to text.
  const binary = medium === "pdf" || medium === "image";
  const data = binary ? b64 : Buffer.from(b64, "base64").toString("utf8");

  let extracted;
  try {
    extracted = await extractRemittance({
      kind: medium,
      data,
      filename: filename || null,
      ...(medium === "image"
        ? { mediaType: imageMediaType(filename, body.mimeType ?? "") }
        : {}),
    });
  } catch (e) {
    return c.json({
      error: "parse_failed",
      errors: [e instanceof Error ? e.message : "could not read the document"],
    } satisfies ApiErrorResponse, 502);
  }

  if (!extracted.isRemittance || !extracted.doc) {
    return c.json({
      isRemittance: extracted.isRemittance,
      reason: extracted.reason ?? "this document does not look like a remittance",
      doc: null, totals: null, lines: [], summary: null,
    });
  }

  const doc     = extracted.doc;
  const totals  = checkTotals(doc);
  const scoped  = body.customerId?.trim() || null;
  const lines   = totals.ok
    ? await resolveLines(orgId, doc, { customerId: scoped })
    : [];

  // Enrich matched lines so the panel can show what it's about to apply
  // without a second round trip.
  const invIds = [...new Set(lines.map((l) => l.invoiceId).filter(Boolean))] as string[];
  const invById = new Map<string, Record<string, unknown>>();
  if (invIds.length) {
    const { data: rows } = await supabase
      .from("invoices")
      .select("id,invoice_number,total,status,customer_id,paid_amount,loads(load_num,internal_load_id)")
      .eq("org_id", orgId)
      .in("id", invIds);
    for (const r of (rows ?? []) as Array<{ id: string }>) invById.set(r.id, r);
  }

  const out = lines.map((l) => {
    const inv = l.invoiceId ? invById.get(l.invoiceId) : null;
    const load = (inv?.loads ?? null) as { load_num?: string | number | null } | null;
    return {
      rowIndex:           l.line.rowIndex,
      referenceAsPrinted: l.line.referenceAsPrinted,
      amount:             l.line.amount,
      deduction:          l.line.deduction ?? null,
      deductionLabel:     l.line.deductionLabel ?? null,
      invoiceId:          l.invoiceId,
      invoiceNumber:      inv ? String(inv.invoice_number ?? "") : null,
      invoiceTotal:       inv ? Number(inv.total ?? 0) : null,
      invoicePaid:        inv ? Number(inv.paid_amount ?? 0) : null,
      invoiceStatus:      inv ? String(inv.status ?? "") : null,
      invoiceCustomerId:  inv ? (inv.customer_id as string | null) : null,
      loadNum:            load?.load_num != null ? String(load.load_num) : null,
      matchedBy:          l.matchedBy,
      confidence:         l.confidence,
      candidates:         l.candidates,
      ambiguous:          l.ambiguous ?? null,
      note:               l.note ?? null,
    };
  });

  const matched = out.filter((l) => l.invoiceId);
  return c.json({
    isRemittance: true,
    reason:       null,
    doc: {
      source:             doc.source,
      payerNameAsPrinted: doc.payerNameAsPrinted,
      paymentDate:        doc.paymentDate,
      paymentTotal:       doc.paymentTotal,
      externalId:         doc.externalId,
      unparsedRows:       doc.unparsedRows ?? [],
    },
    totals,
    // The customer the document itself points at, inferred from the invoices
    // it matched — more reliable than the printed payer name, which is often
    // a factoring company or a legal entity we don't hold under that name.
    inferredCustomerId:
      [...new Set(matched.map((l) => l.invoiceCustomerId).filter(Boolean))].length === 1
        ? (matched[0]?.invoiceCustomerId ?? null)
        : null,
    lines: out,
    summary: {
      lineCount:     out.length,
      matched:       matched.length,
      unmatched:     out.length - matched.length,
      autoApply:     out.filter((l) => l.confidence >= AUTO_APPLY_THRESHOLD && l.invoiceId).length,
      matchedAmount: round2(matched.reduce((s, l) => s + l.amount, 0)),
      totalAmount:   doc.paymentTotal,
    },
  });
});

export default payments;
