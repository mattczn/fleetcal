/**
 * /v1/ramp-category-rules — CRUD for the pattern→bucket mapping the
 * Ramp sync uses to auto-categorize new txns.
 *
 * Each rule points at an expense_buckets row by bucket_id.
 * "Seed defaults" inserts the FleetCal starter set, mapping each
 * default pattern to a bucket by system_role or by name match.
 */

import { Hono } from "hono";
import type {
  RampCategoryRule,
  CreateRampCategoryRuleRequest,
  UpdateRampCategoryRuleRequest,
  ListRampCategoryRulesResponse,
  RampCategoryRuleResponse,
  SeedRampCategoryRulesResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { DEFAULT_RAMP_RULES } from "../lib/rampCategoryMap.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const VALID_ASSET_SCOPES = new Set(["any", "truck", "trailer", "none"]);

interface RuleRow {
  id:          string;
  org_id:      string;
  pattern:     string;
  is_regex:    boolean;
  bucket_id:   string;
  asset_scope: string;
  priority:    number;
  notes:       string | null;
  created_at:  string;
  updated_at:  string;
  expense_buckets?: { name: string } | null;
}

function rowToDomain(r: RuleRow): RampCategoryRule {
  return {
    id:         r.id,
    orgId:      r.org_id,
    pattern:    r.pattern,
    isRegex:    r.is_regex,
    bucketId:   r.bucket_id,
    bucketName: r.expense_buckets?.name ?? undefined,
    assetScope: (r.asset_scope ?? "any") as RampCategoryRule["assetScope"],
    priority:   r.priority,
    notes:      r.notes ?? undefined,
    createdAt:  r.created_at,
    updatedAt:  r.updated_at,
  };
}

const COLS = "id, org_id, pattern, is_regex, bucket_id, asset_scope, priority, notes, created_at, updated_at, expense_buckets!inner(name)";

async function bucketBelongsToOrg(orgId: string, bucketId: string): Promise<boolean> {
  const { data } = await supabase
    .from("expense_buckets")
    .select("id")
    .eq("id", bucketId).eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  return !!data;
}

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
  if (!body.bucketId || !(await bucketBelongsToOrg(orgId, body.bucketId))) {
    return c.json({ error: "bad_request", detail: "bucketId not found in this org" }, 400);
  }
  const isRegex = body.isRegex ?? true;
  if (isRegex) {
    try { new RegExp(body.pattern, "i"); }
    catch (e) {
      return c.json({ error: "bad_request", detail: `invalid regex: ${(e as Error).message}` }, 400);
    }
  }
  if (body.assetScope && !VALID_ASSET_SCOPES.has(body.assetScope)) {
    return c.json({ error: "bad_request", detail: `invalid assetScope: ${body.assetScope}` }, 400);
  }
  const row = {
    org_id:      orgId,
    pattern:     body.pattern.trim(),
    is_regex:    isRegex,
    bucket_id:   body.bucketId,
    asset_scope: body.assetScope ?? "any",
    priority:    body.priority ?? 100,
    notes:       body.notes?.trim() || null,
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
  if (body.bucketId !== undefined) {
    if (!(await bucketBelongsToOrg(orgId, body.bucketId))) {
      return c.json({ error: "bad_request", detail: "bucketId not found in this org" }, 400);
    }
    update.bucket_id = body.bucketId;
  }
  if (body.assetScope !== undefined) {
    if (!VALID_ASSET_SCOPES.has(body.assetScope)) {
      return c.json({ error: "bad_request", detail: `invalid assetScope: ${body.assetScope}` }, 400);
    }
    update.asset_scope = body.assetScope;
  }
  if (body.priority !== undefined) update.priority = body.priority;
  if (body.notes !== undefined) update.notes = body.notes?.trim() || null;

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

/** POST /seed-defaults — insert the built-in starter rules for this org.
 *  Each DEFAULT_RAMP_RULES row targets a legacy bucket_key ('fleet_ops',
 *  'software_overhead', 'insurance_claims'); we look up whichever
 *  expense_buckets row currently holds the matching system_role (for
 *  fleet_ops we use 'mudflap_fuel', for the others we match by name).
 *  If the matching bucket doesn't exist, the rule is skipped. */
rules.post("/seed-defaults", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  try {
    // Load all buckets for this org to map legacy keys → uuids.
    const { data: bucketRows } = await supabase
      .from("expense_buckets")
      .select("id, name, system_role")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .is("parent_id", null);
    const bucketByLegacy = new Map<string, string>();
    for (const b of (bucketRows ?? []) as Array<{ id: string; name: string; system_role: string | null }>) {
      if (b.system_role === 'mudflap_fuel') bucketByLegacy.set('fleet_ops', b.id);
      if (b.system_role === 'driver_pay')   bucketByLegacy.set('payroll_people', b.id);
      // Fallbacks: match by conventional name.
      if (b.name === 'Fleet Operations')    bucketByLegacy.set('fleet_ops', b.id);
      if (b.name === 'Payroll & People')    bucketByLegacy.set('payroll_people', b.id);
      if (b.name === 'Facilities')          bucketByLegacy.set('facilities', b.id);
      if (b.name === 'Insurance & Claims')  bucketByLegacy.set('insurance_claims', b.id);
      if (b.name === 'Software & Overhead') bucketByLegacy.set('software_overhead', b.id);
      if (b.name === 'Capex')               bucketByLegacy.set('capex', b.id);
      if (b.name === 'Taxes')               bucketByLegacy.set('taxes', b.id);
      if (b.name === 'Owner Draws')         bucketByLegacy.set('owner_draws', b.id);
    }

    const { data: existing } = await supabase
      .from("ramp_category_rules")
      .select("pattern")
      .eq("org_id", orgId)
      .is("deleted_at", null);
    const existingPatterns = new Set(
      ((existing ?? []) as Array<{ pattern: string }>).map(r => r.pattern),
    );

    let seeded  = 0;
    let skipped = 0;
    for (const rule of DEFAULT_RAMP_RULES) {
      if (existingPatterns.has(rule.pattern)) { skipped++; continue; }
      const bucketId = bucketByLegacy.get(rule.bucketKey);
      if (!bucketId) { skipped++; continue; }
      const { error } = await supabase.from("ramp_category_rules").insert({
        org_id:    orgId,
        pattern:   rule.pattern,
        is_regex:  true,
        bucket_id: bucketId,
        priority:  100,
        notes:     "seeded from FleetCal defaults",
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
