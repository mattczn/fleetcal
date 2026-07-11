/**
 * /v1/expense-buckets — CRUD for the expense bucket tree that drives
 * the /expenses dashboard tiles.
 *
 * Two-level depth enforced at API layer: a bucket with a parentBucketId
 * cannot itself have children. system_role may sit on any bucket
 * (sub-bucket amounts roll up into the parent tile); assigning a role
 * steals it from whichever bucket previously held it — one per org.
 *
 * DELETE is blocked when the bucket still has expense refs (recurring
 * rules, one-time entries, uncategorized Ramp txns, category rules, or
 * child sub-buckets). The response is a structured 409 so the UI can
 * render "move N entries first" dialogs.
 */

import { Hono } from "hono";
import type {
  ExpenseBucket,
  ExpenseBucketTreeNode,
  ExpenseBucketSystemRole,
  CreateExpenseBucketRequest,
  UpdateExpenseBucketRequest,
  ListExpenseBucketsResponse,
  ExpenseBucketResponse,
  ReorderExpenseBucketsRequest,
  DeleteExpenseBucketBlockedResponse,
  ApiErrorResponse,
} from "@fleetcal/types";
import { EXPENSE_BUCKET_SYSTEM_ROLES } from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const VALID_SYSTEM_ROLES = new Set<ExpenseBucketSystemRole>(EXPENSE_BUCKET_SYSTEM_ROLES);

interface BucketRow {
  id:           string;
  org_id:       string;
  parent_id:    string | null;
  name:         string;
  icon:         string | null;
  color:        string | null;
  sort_order:   number;
  system_role:  string | null;
  created_at:   string;
  updated_at:   string;
}

function rowToDomain(r: BucketRow): ExpenseBucket {
  return {
    id:              r.id,
    orgId:           r.org_id,
    parentBucketId:  r.parent_id ?? undefined,
    name:            r.name,
    icon:            r.icon ?? undefined,
    color:           r.color ?? undefined,
    sortOrder:       r.sort_order,
    systemRole:      (r.system_role ?? undefined) as ExpenseBucketSystemRole | undefined,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
  };
}

const COLS = "id, org_id, parent_id, name, icon, color, sort_order, system_role, created_at, updated_at";

function buildTree(buckets: ExpenseBucket[]): ExpenseBucketTreeNode[] {
  const tops = buckets
    .filter(b => !b.parentBucketId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const byParent = new Map<string, ExpenseBucket[]>();
  for (const b of buckets) {
    if (!b.parentBucketId) continue;
    const arr = byParent.get(b.parentBucketId) ?? [];
    arr.push(b);
    byParent.set(b.parentBucketId, arr);
  }
  return tops.map(top => ({
    bucket:   top,
    children: (byParent.get(top.id) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  }));
}

const buckets = new Hono<{ Variables: AuthVariables }>();
buckets.use("*", requireModule("expenses"), requireCapability("expenses.access"));

buckets.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("expense_buckets")
    .select(COLS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as unknown as BucketRow[]).map(rowToDomain);
  const res: ListExpenseBucketsResponse = {
    buckets: rows,
    tree:    buildTree(rows),
  };
  return c.json(res);
});

buckets.post("/", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateExpenseBucketRequest>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", detail: "invalid json body" }, 400);
  if (!body.name?.trim()) {
    return c.json({ error: "bad_request", detail: "name is required" }, 400);
  }
  if (body.systemRole && !VALID_SYSTEM_ROLES.has(body.systemRole)) {
    return c.json({ error: "bad_request", detail: `invalid systemRole: ${body.systemRole}` }, 400);
  }

  // Two-level depth: if creating a child, ensure the parent is top-level.
  if (body.parentBucketId) {
    const { data: parent, error: pErr } = await supabase
      .from("expense_buckets")
      .select("id, parent_id")
      .eq("id", body.parentBucketId).eq("org_id", orgId)
      .maybeSingle();
    if (pErr) return c.json({ error: "fetch_failed", detail: pErr.message }, 500);
    if (!parent) return c.json({ error: "bad_request", detail: "parent bucket not found" }, 400);
    if ((parent as { parent_id: string | null }).parent_id) {
      return c.json({ error: "bad_request", detail: "sub-buckets cannot have their own children (2-level max)" }, 400);
    }
  }

  // Assigning a system role steals it from whichever bucket held it —
  // matches the UI copy ("moves it off any other bucket") and beats a
  // unique-violation error the user has to untangle by hand.
  if (body.systemRole) {
    await supabase
      .from("expense_buckets")
      .update({ system_role: null })
      .eq("org_id", orgId)
      .eq("system_role", body.systemRole)
      .is("deleted_at", null);
  }

  const row = {
    org_id:      orgId,
    parent_id:   body.parentBucketId ?? null,
    name:        body.name.trim(),
    icon:        body.icon?.trim() || null,
    color:       body.color?.trim() || null,
    sort_order:  body.sortOrder ?? 999,
    system_role: body.systemRole ?? null,
  };
  const { data, error } = await supabase
    .from("expense_buckets")
    .insert(row)
    .select(COLS)
    .single();
  if (error || !data) {
    // Unique violation on (org_id, system_role) partial index — friendlier message.
    if (error && (error as { code?: string }).code === "23505" && error.message?.includes("system_role")) {
      return c.json({ error: "bad_request", detail: "another bucket already holds that system role" }, 400);
    }
    return c.json({ error: "insert_failed", detail: error?.message ?? "unknown" }, 500);
  }
  const res: ExpenseBucketResponse = { bucket: rowToDomain(data as unknown as BucketRow) };
  return c.json(res);
});

buckets.patch("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const body = await c.req.json<UpdateExpenseBucketRequest>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", detail: "invalid json body" }, 400);

  // Load current row (need parent_id to enforce depth/system_role rules).
  const { data: current, error: cErr } = await supabase
    .from("expense_buckets")
    .select(COLS)
    .eq("id", id).eq("org_id", orgId)
    .maybeSingle();
  if (cErr)     return c.json({ error: "fetch_failed", detail: cErr.message }, 500);
  if (!current) return c.json({ error: "not_found" }, 404);
  const cur = current as BucketRow;

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: "bad_request", detail: "name cannot be empty" }, 400);
    update.name = body.name.trim();
  }
  if (body.icon      !== undefined) update.icon       = body.icon  == null ? null : body.icon.trim();
  if (body.color     !== undefined) update.color      = body.color == null ? null : body.color.trim();
  if (body.sortOrder !== undefined) update.sort_order = body.sortOrder;

  if (body.systemRole !== undefined) {
    if (body.systemRole && !VALID_SYSTEM_ROLES.has(body.systemRole)) {
      return c.json({ error: "bad_request", detail: `invalid systemRole: ${body.systemRole}` }, 400);
    }
    // Steal the role from whichever bucket currently holds it (see POST).
    if (body.systemRole) {
      await supabase
        .from("expense_buckets")
        .update({ system_role: null })
        .eq("org_id", orgId)
        .eq("system_role", body.systemRole)
        .is("deleted_at", null);
    }
    update.system_role = body.systemRole;
  }

  if (body.parentBucketId !== undefined) {
    if (body.parentBucketId === id) {
      return c.json({ error: "bad_request", detail: "a bucket cannot be its own parent" }, 400);
    }
    if (body.parentBucketId) {
      const { data: parent } = await supabase
        .from("expense_buckets")
        .select("id, parent_id")
        .eq("id", body.parentBucketId).eq("org_id", orgId)
        .maybeSingle();
      if (!parent) return c.json({ error: "bad_request", detail: "parent bucket not found" }, 400);
      if ((parent as { parent_id: string | null }).parent_id) {
        return c.json({ error: "bad_request", detail: "sub-buckets cannot have their own children (2-level max)" }, 400);
      }
      // System roles survive a move — sub-buckets may carry them (the
      // auto-fed amount rolls up into the new parent's total).
      // Can't move a bucket that has children though — that would make
      // it a 3-level tree.
      const { count } = await supabase
        .from("expense_buckets")
        .select("id", { count: "exact", head: true })
        .eq("parent_id", id)
        .is("deleted_at", null);
      if ((count ?? 0) > 0) {
        return c.json({ error: "bad_request", detail: "move sub-buckets out first before demoting a parent" }, 400);
      }
    }
    update.parent_id = body.parentBucketId;
  }

  const { data, error } = await supabase
    .from("expense_buckets")
    .update(update)
    .eq("id", id).eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    if (error && (error as { code?: string }).code === "23505" && error.message?.includes("system_role")) {
      return c.json({ error: "bad_request", detail: "another bucket already holds that system role" }, 400);
    }
    return c.json({ error: "update_failed", detail: error?.message ?? "unknown" }, 500);
  }
  const res: ExpenseBucketResponse = { bucket: rowToDomain(data as unknown as BucketRow) };
  return c.json(res);
});

buckets.post("/reorder", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<ReorderExpenseBucketsRequest>().catch(() => null);
  if (!body || !Array.isArray(body.orderedIds)) {
    return c.json({ error: "bad_request", detail: "orderedIds must be an array" }, 400);
  }
  // Fire-and-forget the updates. Any failure fails the whole call.
  for (let i = 0; i < body.orderedIds.length; i++) {
    const id = body.orderedIds[i];
    const { error } = await supabase
      .from("expense_buckets")
      .update({ sort_order: i * 10 })
      .eq("id", id).eq("org_id", orgId);
    if (error) {
      return c.json({ error: "reorder_failed", detail: error.message }, 500);
    }
  }
  return c.json({ ok: true });
});

/** DELETE — blocks with a structured 409 when references exist. Use
 *  the returned counts to prompt the user to move entries first. */
buckets.delete("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data: bucket } = await supabase
    .from("expense_buckets")
    .select("id, system_role")
    .eq("id", id).eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!bucket) return c.json({ error: "not_found" }, 404);
  const b = bucket as { id: string; system_role: string | null };

  const [recurringRes, entriesRes, rampTxnsRes, rampRulesRes, subBucketsRes] = await Promise.all([
    supabase.from("recurring_expenses").select("id", { count: "exact", head: true }).eq("bucket_id", id).is("deleted_at", null),
    supabase.from("expense_entries").select("id", { count: "exact", head: true }).eq("bucket_id", id).is("deleted_at", null),
    supabase.from("ramp_transactions").select("id", { count: "exact", head: true }).eq("bucket_id", id).is("deleted_at", null),
    supabase.from("ramp_category_rules").select("id", { count: "exact", head: true }).eq("bucket_id", id).is("deleted_at", null),
    supabase.from("expense_buckets").select("id", { count: "exact", head: true }).eq("parent_id", id).is("deleted_at", null),
  ]);
  const recurring  = recurringRes.count ?? 0;
  const entries    = entriesRes.count ?? 0;
  const rampTxns   = rampTxnsRes.count ?? 0;
  const rampRules  = rampRulesRes.count ?? 0;
  const subBuckets = subBucketsRes.count ?? 0;
  const total = recurring + entries + rampTxns + rampRules + subBuckets;

  if (total > 0 || b.system_role) {
    const parts: string[] = [];
    if (recurring)  parts.push(`${recurring} recurring rule${recurring === 1 ? '' : 's'}`);
    if (entries)    parts.push(`${entries} one-time entr${entries === 1 ? 'y' : 'ies'}`);
    if (rampTxns)   parts.push(`${rampTxns} card txn${rampTxns === 1 ? '' : 's'}`);
    if (rampRules)  parts.push(`${rampRules} auto-categorization rule${rampRules === 1 ? '' : 's'}`);
    if (subBuckets) parts.push(`${subBuckets} sub-bucket${subBuckets === 1 ? '' : 's'}`);
    if (b.system_role) parts.push(`system role "${b.system_role}" (reassign to another bucket first)`);
    const res: DeleteExpenseBucketBlockedResponse = {
      error: "delete_blocked",
      detail: `Move ${parts.join(', ')} before deleting.`,
      references: {
        recurring, entries, rampTxns, rampRules, subBuckets,
        systemRole: (b.system_role ?? null) as ExpenseBucketSystemRole | null,
      },
    };
    return c.json(res, 409);
  }

  const { error } = await supabase
    .from("expense_buckets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id).eq("org_id", orgId);
  if (error) return c.json({ error: "delete_failed", detail: error.message }, 500);
  return c.json({ ok: true });
});

export default buckets;
