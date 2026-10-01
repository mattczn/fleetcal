/**
 * /v1/weekly-target — the dashboard's weekly profitability calculator.
 *
 *   GET  /?week=YYYY-MM-DD   model for the Sat–Fri week containing `week`
 *                            (default: current week). See lib/weeklyTarget.
 *   PUT  /settings           patch org_settings.weekly_target_settings;
 *                            null clears an override back to computed.
 *
 * Gated like /expenses: the model reads the expense buckets, so anyone
 * who can't see expenses shouldn't see the derived costs either.
 */

import { Hono } from "hono";
import type { ApiErrorResponse, WeeklyTargetSettings } from "@fleetcal/types";
import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { computeWeeklyTarget, mergeSettings, readSettings, validateSettingsPatch } from "../lib/weeklyTarget.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const weeklyTarget = new Hono<{ Variables: AuthVariables }>();
weeklyTarget.use("*", requireModule("expenses"), requireCapability("expenses.access"));

weeklyTarget.get("/", async (c) => {
  const orgId = c.get("orgId");
  const week = c.req.query("week");
  if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return c.json({ error: "validation_failed", errors: ["week must be YYYY-MM-DD"] } satisfies ApiErrorResponse, 400);
  }
  try {
    return c.json(await computeWeeklyTarget(orgId, { week: week ?? undefined }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[GET /v1/weekly-target]", detail);
    return c.json({ error: "weekly_target_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

weeklyTarget.put("/settings", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json().catch(() => null);
  const { patch, errors } = validateSettingsPatch(body);
  if (errors.length || !patch) {
    return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);
  }
  const { settings, unavailable } = await readSettings(orgId);
  if (unavailable) {
    return c.json({
      error: "settings_unavailable",
      detail: "org_settings.weekly_target_settings doesn't exist yet — run the 20261001_org_settings_weekly_target migration.",
    } satisfies ApiErrorResponse, 409);
  }
  const next: WeeklyTargetSettings = mergeSettings(settings, patch);
  const { error } = await supabase
    .from("org_settings")
    .upsert({ org_id: orgId, weekly_target_settings: next }, { onConflict: "org_id" });
  if (error) {
    console.error("[PUT /v1/weekly-target/settings]", error.message);
    return c.json({ error: "save_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ settings: next });
});

export default weeklyTarget;
