/**
 * Invoice settlement — recomputing invoices.paid_* from the allocation
 * ledger.
 *
 * `invoice_payments` is the source of truth for what an invoice has been
 * paid. The columns on `invoices` (paid_at / paid_amount / paid_method /
 * paid_note / status) are a denormalized summary kept for cheap list
 * queries and for the existing /accounting board, which reads them
 * directly.
 *
 * Every write that adds, edits, or removes an allocation MUST call
 * recomputeInvoicePaid() afterward. Nothing else may write paid_amount.
 * That single-writer rule is what keeps the two representations from
 * drifting — the failure mode in the predecessor system was two
 * subsystems both claiming authorship of "paid".
 *
 * Settlement rule: an invoice is `paid` once applied >= total (within a
 * cent). Anything less leaves it `sent` with a partial paid_amount —
 * there is deliberately no `partially_paid` status, because the
 * /accounting board's bucket logic keys off the four existing statuses
 * and a fifth would silently drop partial invoices out of every view
 * that enumerates them. The Receivables page distinguishes partial from
 * untouched via balance, which is derived.
 */

import { supabase as supabaseTyped } from "./supabase.js";

// invoice_payments / payment_proofs aren't in the generated Database
// types until the schema is regenerated post-migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

/** Float-safe money compare. Totals are float8 on invoices and
 *  numeric(12,2) on allocations; a half-cent slop keeps a $1,234.56
 *  invoice from reading as unpaid because of representation drift. */
const CENT = 0.005;

export interface InvoiceSettlement {
  total:    number;
  applied:  number;
  balance:  number;
  isPaid:   boolean;
  /** Latest paid_on across allocations, ISO date. Undefined when none. */
  lastPaidOn?: string;
  paymentCount: number;
  /** True when at least one allocation cites a proof. */
  hasProof: boolean;
}

interface AllocRow {
  amount:   string | number;
  paid_on:  string;
  method:   string | null;
  proof_id: string | null;
}

/**
 * Reads an invoice's allocations and writes the summary back onto the
 * invoice row. Returns the settlement math, or null when the invoice
 * doesn't exist in this org.
 *
 * Void invoices are left alone entirely: voiding is an accounting
 * decision that outranks payment state, and flipping a void invoice to
 * paid because a stale allocation exists would resurrect it into the
 * billing board.
 */
export async function recomputeInvoicePaid(
  invoiceId: string,
  orgId:     string,
): Promise<InvoiceSettlement | null> {
  const { data: inv } = await supabase
    .from("invoices")
    .select("id,total,status,paid_note")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!inv) return null;

  const invoice = inv as { id: string; total: number | null; status: string; paid_note: string | null };
  if (invoice.status === "void") return null;

  const { data: rows } = await supabase
    .from("invoice_payments")
    .select("amount,paid_on,method,proof_id")
    .eq("invoice_id", invoiceId)
    .eq("org_id", orgId);

  const allocs = (rows ?? []) as AllocRow[];
  const total   = Number(invoice.total ?? 0);
  const applied = round2(allocs.reduce((s, r) => s + Number(r.amount), 0));
  const isPaid  = allocs.length > 0 && applied >= total - CENT;

  // Latest allocation drives paid_at and paid_method — for a partial
  // series, "when was this paid" means the most recent money in.
  const latest = allocs.length
    ? allocs.reduce((a, b) => (a.paid_on >= b.paid_on ? a : b))
    : null;

  const update: Record<string, unknown> = {
    paid_amount: allocs.length ? applied : null,
    paid_at:     isPaid && latest ? new Date(`${latest.paid_on}T12:00:00Z`).toISOString() : null,
    paid_method: isPaid && latest ? normalizeMethod(latest.method) : null,
  };

  // Status only moves between sent and paid. A draft that gets paid is
  // promoted to paid (matching mark-paid's existing tolerance for
  // draft → paid); a paid invoice whose allocations are reversed lands
  // back on sent, same as unmark-paid.
  if (isPaid) {
    update.status = "paid";
  } else if (invoice.status === "paid") {
    update.status = "sent";
  }

  await supabase.from("invoices").update(update).eq("id", invoiceId).eq("org_id", orgId);

  return {
    total,
    applied,
    balance:      round2(total - applied),
    isPaid,
    lastPaidOn:   latest?.paid_on,
    paymentCount: allocs.length,
    hasProof:     allocs.some((r) => r.proof_id !== null),
  };
}

/** invoices.paid_method predates the allocation ledger and has no
 *  'factoring' member. Map it down rather than widening the older
 *  column's contract — the precise method lives on the allocation. */
function normalizeMethod(m: string | null): string | null {
  if (!m) return null;
  return m === "factoring" ? "other" : m;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sum of allocations per proof — used to flag partially-applied
 * evidence. Returns a map keyed by proof id; proofs with no allocations
 * are absent, so callers should default to 0.
 */
export async function appliedByProof(
  orgId:    string,
  proofIds: string[],
): Promise<Record<string, number>> {
  if (!proofIds.length) return {};
  const { data } = await supabase
    .from("invoice_payments")
    .select("proof_id,amount")
    .eq("org_id", orgId)
    .in("proof_id", proofIds);

  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { proof_id: string | null; amount: string | number }[]) {
    if (!r.proof_id) continue;
    out[r.proof_id] = round2((out[r.proof_id] ?? 0) + Number(r.amount));
  }
  return out;
}
