/**
 * /v1/expense-entries — CRUD for one-off / ad-hoc expenses.
 *
 * Points at an expense_buckets row via bucket_id.
 */

import { Hono } from "hono";
import type {
  ExpenseEntry,
  ListExpenseEntriesResponse,
  CreateExpenseEntryRequest,
  UpdateExpenseEntryRequest,
  ExpenseEntryResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

interface EntryRow {
  id:         string;
  org_id:     string;
  bucket_id:  string;
  kind:       string | null;
  date:       string;
  amount:     string | number;
  label:      string;
  notes:      string | null;
  created_at: string;
  updated_at: string;
  expense_buckets?: { name: string } | null;
}

function rowToDomain(r: EntryRow): ExpenseEntry {
  return {
    id:         r.id,
    orgId:      r.org_id,
    bucketId:   r.bucket_id,
    bucketName: r.expense_buckets?.name ?? undefined,
    kind:       r.kind ?? undefined,
    date:       r.date,
    amount:     Number(r.amount),
    label:      r.label,
    notes:      r.notes ?? undefined,
    createdAt:  r.created_at,
    updatedAt:  r.updated_at,
  };
}

const COLS = "id, org_id, bucket_id, kind, date, amount, label, notes, created_at, updated_at, expense_buckets!inner(name)";

const entries = new Hono<{ Variables: AuthVariables }>();
entries.use("*", requireModule("expenses"), requireCapability("expenses.access"));

async function bucketBelongsToOrg(orgId: string, bucketId: string): Promise<boolean> {
  const { data } = await supabase
    .from("expense_buckets")
    .select("id")
    .eq("id", bucketId).eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

entries.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from      = url.searchParams.get("from");
  const to        = url.searchParams.get("to");
  const bucketId  = url.searchParams.get("bucketId");
  const kind      = url.searchParams.get("kind");
  const limit  = Math.min(Math.max(Number(url.searchParams.get("limit")  ?? "200"), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);

  let query = supabase
    .from("expense_entries")
    .select(COLS, { count: "exact" })
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (from)     query = query.gte("date", from);
  if (to)       query = query.lte("date", to);
  if (bucketId) query = query.eq("bucket_id", bucketId);
  if (kind)     query = query.eq("kind", kind);

  const { data, error, count } = await query
    .order("date", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as unknown as EntryRow[]).map(rowToDomain);
  const res: ListExpenseEntriesResponse = {
    expenseEntries: rows,
    total:          count ?? rows.length,
  };
  return c.json(res);
});

entries.post("/", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateExpenseEntryRequest>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", detail: "invalid json body" }, 400);
  if (!body.bucketId) return c.json({ error: "bad_request", detail: "bucketId is required" }, 400);
  if (!(await bucketBelongsToOrg(orgId, body.bucketId))) {
    return c.json({ error: "bad_request", detail: "bucketId not found in this org" }, 400);
  }
  if (!body.label?.trim()) {
    return c.json({ error: "bad_request", detail: "label is required" }, 400);
  }
  if (typeof body.amount !== "number" || !isFinite(body.amount) || body.amount <= 0) {
    return c.json({ error: "bad_request", detail: "amount must be > 0" }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return c.json({ error: "bad_request", detail: "date must be YYYY-MM-DD" }, 400);
  }
  const row = {
    org_id:    orgId,
    bucket_id: body.bucketId,
    kind:      body.kind?.trim() || null,
    date:      body.date,
    amount:    body.amount,
    label:     body.label.trim(),
    notes:     body.notes?.trim() || null,
  };
  const { data, error } = await supabase
    .from("expense_entries")
    .insert(row)
    .select(COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "insert_failed", detail: error?.message ?? "unknown" } satisfies ApiErrorResponse, 500);
  }
  const res: ExpenseEntryResponse = {
    expenseEntry: rowToDomain(data as unknown as EntryRow),
  };
  return c.json(res);
});

entries.patch("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const body = await c.req.json<UpdateExpenseEntryRequest>().catch(() => null);
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
  if (body.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return c.json({ error: "bad_request", detail: "date must be YYYY-MM-DD" }, 400);
    }
    update.date = body.date;
  }
  if (body.amount !== undefined) {
    if (typeof body.amount !== "number" || !isFinite(body.amount) || body.amount <= 0) {
      return c.json({ error: "bad_request", detail: "amount must be > 0" }, 400);
    }
    update.amount = body.amount;
  }
  if (body.label !== undefined) {
    if (!body.label.trim()) return c.json({ error: "bad_request", detail: "label cannot be empty" }, 400);
    update.label = body.label.trim();
  }
  if (body.notes !== undefined) {
    update.notes = body.notes?.trim() || null;
  }

  const { data, error } = await supabase
    .from("expense_entries")
    .update(update)
    .eq("id", id).eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "update_failed", detail: error?.message ?? "not_found" } satisfies ApiErrorResponse, 500);
  }
  const res: ExpenseEntryResponse = {
    expenseEntry: rowToDomain(data as unknown as EntryRow),
  };
  return c.json(res);
});

entries.delete("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { error } = await supabase
    .from("expense_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id).eq("org_id", orgId);
  if (error) {
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

export default entries;
