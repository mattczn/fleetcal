/**
 * /v1/recurring-expenses — CRUD for the recurring rules that feed the
 * /expenses dashboard's tiles.
 *
 * Each rule points at an expense_buckets row via bucket_id. Bucket
 * validity is FK-enforced.
 */

import { Hono } from "hono";
import type {
  RecurringExpense,
  RecurringExpenseCadence,
  CreateRecurringExpenseRequest,
  UpdateRecurringExpenseRequest,
  ListRecurringExpensesResponse,
  RecurringExpenseResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const VALID_CADENCES = new Set<RecurringExpenseCadence>(['weekly', 'monthly']);

interface RecurringRow {
  id:             string;
  org_id:         string;
  bucket_id:      string;
  kind:           string | null;
  label:          string;
  amount:         string | number;
  cadence:        string;
  effective_from: string;
  effective_to:   string | null;
  notes:          string | null;
  created_at:     string;
  updated_at:     string;
  expense_buckets?: { name: string } | null;
}

function rowToDomain(r: RecurringRow): RecurringExpense {
  return {
    id:            r.id,
    orgId:         r.org_id,
    bucketId:      r.bucket_id,
    bucketName:    r.expense_buckets?.name ?? undefined,
    kind:          r.kind ?? undefined,
    label:         r.label,
    amount:        Number(r.amount),
    cadence:       r.cadence as RecurringExpenseCadence,
    effectiveFrom: r.effective_from,
    effectiveTo:   r.effective_to ?? undefined,
    notes:         r.notes ?? undefined,
    createdAt:     r.created_at,
    updatedAt:     r.updated_at,
  };
}

const COLS = "id, org_id, bucket_id, kind, label, amount, cadence, effective_from, effective_to, notes, created_at, updated_at, expense_buckets!inner(name)";

const recurring = new Hono<{ Variables: AuthVariables }>();
recurring.use("*", requireModule("expenses"), requireCapability("expenses.access"));

async function bucketBelongsToOrg(orgId: string, bucketId: string): Promise<boolean> {
  const { data } = await supabase
    .from("expense_buckets")
    .select("id")
    .eq("id", bucketId).eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

recurring.get("/", async (c) => {
  const orgId = c.get("orgId");
  const includeEnded = c.req.query("includeEnded") !== "false";
  const today = new Date().toISOString().slice(0, 10);

  let query = supabase
    .from("recurring_expenses")
    .select(COLS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("effective_from", { ascending: false });
  if (!includeEnded) {
    query = query.or(`effective_to.is.null,effective_to.gte.${today}`);
  }
  const { data, error } = await query;
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as unknown as RecurringRow[]).map(rowToDomain);
  const res: ListRecurringExpensesResponse = { recurringExpenses: rows };
  return c.json(res);
});

recurring.post("/", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateRecurringExpenseRequest>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", detail: "invalid json body" }, 400);
  if (!body.bucketId) return c.json({ error: "bad_request", detail: "bucketId is required" }, 400);
  if (!(await bucketBelongsToOrg(orgId, body.bucketId))) {
    return c.json({ error: "bad_request", detail: "bucketId not found in this org" }, 400);
  }
  if (!VALID_CADENCES.has(body.cadence)) {
    return c.json({ error: "bad_request", detail: `invalid cadence: ${body.cadence}` }, 400);
  }
  if (!body.label?.trim()) {
    return c.json({ error: "bad_request", detail: "label is required" }, 400);
  }
  if (typeof body.amount !== "number" || !isFinite(body.amount) || body.amount <= 0) {
    return c.json({ error: "bad_request", detail: "amount must be > 0" }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom)) {
    return c.json({ error: "bad_request", detail: "effectiveFrom must be YYYY-MM-DD" }, 400);
  }
  if (body.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveTo)) {
    return c.json({ error: "bad_request", detail: "effectiveTo must be YYYY-MM-DD" }, 400);
  }

  const row = {
    org_id:         orgId,
    bucket_id:      body.bucketId,
    kind:           body.kind?.trim() || null,
    label:          body.label.trim(),
    amount:         body.amount,
    cadence:        body.cadence,
    effective_from: body.effectiveFrom,
    effective_to:   body.effectiveTo ?? null,
    notes:          body.notes?.trim() || null,
  };
  const { data, error } = await supabase
    .from("recurring_expenses")
    .insert(row)
    .select(COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "insert_failed", detail: error?.message ?? "unknown" } satisfies ApiErrorResponse, 500);
  }
  const res: RecurringExpenseResponse = {
    recurringExpense: rowToDomain(data as unknown as RecurringRow),
  };
  return c.json(res);
});

recurring.patch("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<UpdateRecurringExpenseRequest>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", detail: "invalid json body" }, 400);

  const update: Record<string, unknown> = {};
  if (body.bucketId !== undefined) {
    if (!(await bucketBelongsToOrg(orgId, body.bucketId))) {
      return c.json({ error: "bad_request", detail: "bucketId not found in this org" }, 400);
    }
    update.bucket_id = body.bucketId;
  }
  if (body.kind !== undefined) {
    update.kind = body.kind == null ? null : (body.kind.trim() || null);
  }
  if (body.label !== undefined) {
    if (!body.label.trim()) return c.json({ error: "bad_request", detail: "label cannot be empty" }, 400);
    update.label = body.label.trim();
  }
  if (body.amount !== undefined) {
    if (typeof body.amount !== "number" || !isFinite(body.amount) || body.amount <= 0) {
      return c.json({ error: "bad_request", detail: "amount must be > 0" }, 400);
    }
    update.amount = body.amount;
  }
  if (body.cadence !== undefined) {
    if (!VALID_CADENCES.has(body.cadence)) {
      return c.json({ error: "bad_request", detail: `invalid cadence: ${body.cadence}` }, 400);
    }
    update.cadence = body.cadence;
  }
  if (body.effectiveFrom !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom)) {
      return c.json({ error: "bad_request", detail: "effectiveFrom must be YYYY-MM-DD" }, 400);
    }
    update.effective_from = body.effectiveFrom;
  }
  if (body.effectiveTo !== undefined) {
    if (body.effectiveTo !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveTo)) {
      return c.json({ error: "bad_request", detail: "effectiveTo must be YYYY-MM-DD or null" }, 400);
    }
    update.effective_to = body.effectiveTo;
  }
  if (body.notes !== undefined) {
    update.notes = body.notes?.trim() || null;
  }

  const { data, error } = await supabase
    .from("recurring_expenses")
    .update(update)
    .eq("id", id).eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "update_failed", detail: error?.message ?? "not_found" } satisfies ApiErrorResponse, 500);
  }
  const res: RecurringExpenseResponse = {
    recurringExpense: rowToDomain(data as unknown as RecurringRow),
  };
  return c.json(res);
});

recurring.post("/:id/end", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("recurring_expenses")
    .update({ effective_to: today })
    .eq("id", id).eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "update_failed", detail: error?.message ?? "not_found" } satisfies ApiErrorResponse, 500);
  }
  const res: RecurringExpenseResponse = {
    recurringExpense: rowToDomain(data as unknown as RecurringRow),
  };
  return c.json(res);
});

recurring.delete("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("recurring_expenses")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id).eq("org_id", orgId);
  if (error) {
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

export default recurring;
