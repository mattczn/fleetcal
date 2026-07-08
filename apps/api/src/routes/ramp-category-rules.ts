/**
 * /v1/ramp-category-rules — CRUD for the pattern→bucket mapping the
 * Ramp sync uses to auto-categorize new txns.
 *
 * Replaces the hardcoded regex table that used to live in
 * lib/rampCategoryMap.ts. The map is still there but only as a source
 * for the "Seed defaults" endpoint — once seeded, only DB rules apply.
 *
 * Match priority: lowest number first. Defaults seed at priority 100
 * so custom user rules at priority 10 take precedence.
 *
 * Module-gated on "expenses". Mutations require org.settings.edit.
 */

import { Hono } from "hono";
import type {
  RampCategoryRule,
  ExpenseBucketKey,
  CreateRampCategoryRuleRequest,
  UpdateRampCategoryRuleRequest,
  ListRampCategoryRulesResponse,
  RampCategoryRuleResponse,
  SeedRampCategoryRulesResponse,
  ApiErrorResponse,
} from "@fleetcal/types";
import { EXPENSE_BUCKET_KEYS } from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { DEFAULT_RAMP_RULES } from "../lib/rampCategoryMap.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const VALID_BUCKETS = new Set<ExpenseBucketKey>(EXPENSE_BUCKET_KEYS);

interface RuleRow {
  id:         string;
  org_id:     string;
  pattern:    string;
  is_regex:   boolean;
  bucket_key: string;
  priority:   number;
  notes:      string | null;
  created_at: string;
  updated_at: string;
}

function rowToDomain(r: RuleRow): RampCategoryRule {
  return {
    id:        r.id,
    orgId:     r.org_id,
    pattern:   r.pattern,
    isRegex:   r.is_regex,
    bucketKey: r.bucket_key as ExpenseBucketKey,
    priority:  r.priority,
    notes:     r.notes ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS = "id, org_id, pattern, is_regex, bucket_key, priority, notes, created_at, updated_at";

const rules = new Hono<{ Variables: AuthVariables }>();
rules.use("*", requireModule("expenses"), requireCapability("expenses.access"));

rules.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("ramp_category_rules")
    .select(COLS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as unknown as RuleRow[]).map(rowToDomain);
  const res: ListRampCategoryRulesResponse = { rules: rows };
  return c.json(res);
});

rules.post("/", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateRampCategoryRuleRequest>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", detail: "invalid json body" }, 400);
  if (!body.pattern?.trim()) {
    return c.json({ error: "bad_request", detail: "pattern is required" }, 400);
  }
  if (!VALID_BUCKETS.has(body.bucketKey)) {
    return c.json({ error: "bad_request", detail: `invalid bucketKey: ${body.bucketKey}` }, 400);
  }
  const isRegex = body.isRegex ?? true;
  if (isRegex) {
    try { new RegExp(body.pattern, "i"); }
    catch (e) {
      return c.json({ error: "bad_request", detail: `invalid regex: ${(e as Error).message}` }, 400);
    }
  }
  const row = {
    org_id:     orgId,
    pattern:    body.pattern.trim(),
    is_regex:   isRegex,
    bucket_key: body.bucketKey,
    priority:   body.priority ?? 100,
    notes:      body.notes?.trim() || null,
  };
  const { data, error } = await supabase
    .from("ramp_category_rules")
    .insert(row)
    .select(COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "insert_failed", detail: error?.message ?? "unknown" } satisfies ApiErrorResponse, 500);
  }
  const res: RampCategoryRuleResponse = { rule: rowToDomain(data as unknown as RuleRow) };
  return c.json(res);
});

rules.patch("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const body = await c.req.json<UpdateRampCategoryRuleRequest>().catch(() => null);
  if (!body) return c.json({ error: "bad_request", detail: "invalid json body" }, 400);

  const update: Record<string, unknown> = {};
  if (body.pattern !== undefined) {
    if (!body.pattern.trim()) return c.json({ error: "bad_request", detail: "pattern cannot be empty" }, 400);
    update.pattern = body.pattern.trim();
  }
  if (body.isRegex !== undefined) update.is_regex = body.isRegex;
  if (body.bucketKey !== undefined) {
    if (!VALID_BUCKETS.has(body.bucketKey)) {
      return c.json({ error: "bad_request", detail: `invalid bucketKey: ${body.bucketKey}` }, 400);
    }
    update.bucket_key = body.bucketKey;
  }
  if (body.priority !== undefined) update.priority = body.priority;
  if (body.notes !== undefined) update.notes = body.notes?.trim() || null;

  // Validate regex if either pattern OR is_regex is being changed to true.
  if ((update.is_regex ?? undefined) !== false && update.pattern) {
    try { new RegExp(update.pattern as string, "i"); }
    catch (e) {
      return c.json({ error: "bad_request", detail: `invalid regex: ${(e as Error).message}` }, 400);
    }
  }

  const { data, error } = await supabase
    .from("ramp_category_rules")
    .update(update)
    .eq("id", id).eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "update_failed", detail: error?.message ?? "not_found" } satisfies ApiErrorResponse, 500);
  }
  const res: RampCategoryRuleResponse = { rule: rowToDomain(data as unknown as RuleRow) };
  return c.json(res);
});

rules.delete("/:id", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { error } = await supabase
    .from("ramp_category_rules")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id).eq("org_id", orgId);
  if (error) {
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

/** POST /v1/ramp-category-rules/seed-defaults
 *  Insert the built-in DEFAULT_RAMP_RULES for this org, skipping any
 *  that already exist by pattern. Idempotent — safe to call multiple
 *  times. */
rules.post("/seed-defaults", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  try {
    const { data: existing } = await supabase
      .from("ramp_category_rules")
      .select("pattern")
      .eq("org_id", orgId)
      .is("deleted_at", null);
    const existingPatterns = new Set(
      ((existing ?? []) as Array<{ pattern: string }>).map(r => r.pattern),
    );

    let seeded = 0;
    let skipped = 0;
    for (const rule of DEFAULT_RAMP_RULES) {
      if (existingPatterns.has(rule.pattern)) { skipped++; continue; }
      const { error } = await supabase.from("ramp_category_rules").insert({
        org_id:     orgId,
        pattern:    rule.pattern,
        is_regex:   true,
        bucket_key: rule.bucketKey,
        priority:   100,
        notes:      "seeded from FleetCal defaults",
      });
      if (error) continue;
      seeded++;
    }
    const res: SeedRampCategoryRulesResponse = { seeded, skipped };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: "seed_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

export default rules;
