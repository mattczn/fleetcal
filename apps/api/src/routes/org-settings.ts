/**
 * /v1/org-settings — per-org preferences.
 *
 * Defaults when no row exists yet:
 *   showDriverPay = false
 *   rateConSettings = {} (empty; client falls back to its built-in defaults)
 *
 * Other org_settings columns (motive_api_key etc.) are intentionally not
 * exposed here — they're read by server-side proxies only.
 */

import { Hono } from "hono";
import {
  type GetOrgSettingsResponse,
  type RateConSettings,
  type UpdateOrgSettingsRequest,
  type UpdateOrgSettingsResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const orgSettings = new Hono<{ Variables: AuthVariables }>();

orgSettings.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("org_settings")
    .select("show_driver_pay,rate_con_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/org-settings] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const row = data as { show_driver_pay: boolean; rate_con_settings: RateConSettings | null } | null;
  const res: GetOrgSettingsResponse = {
    settings: {
      showDriverPay:    row?.show_driver_pay   ?? false,
      rateConSettings:  row?.rate_con_settings ?? {},
    },
  };
  return c.json(res);
});

orgSettings.patch("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<UpdateOrgSettingsRequest>();
  // At least one allowed key must be present.
  if (
    body.showDriverPay  === undefined &&
    body.rateConSettings === undefined
  ) {
    return c.json({ error: "validation_failed", errors: ["showDriverPay or rateConSettings required"] } satisfies ApiErrorResponse, 400);
  }

  // Read existing row first so we can patch the JSONB partially without
  // clobbering keys the caller didn't include.
  const { data: existing } = await supabase
    .from("org_settings")
    .select("show_driver_pay,rate_con_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  const existingRow = existing as { show_driver_pay: boolean; rate_con_settings: RateConSettings | null } | null;

  const nextShowDriverPay = body.showDriverPay  ?? existingRow?.show_driver_pay  ?? false;
  const mergedRateCon: RateConSettings = body.rateConSettings === undefined
    ? (existingRow?.rate_con_settings ?? {})
    : { ...(existingRow?.rate_con_settings ?? {}), ...(body.rateConSettings ?? {}) };

  const { error } = await supabase
    .from("org_settings")
    .upsert(
      {
        org_id:            orgId,
        show_driver_pay:   nextShowDriverPay,
        rate_con_settings: mergedRateCon as never,
      } as never,
      { onConflict: "org_id" },
    );
  if (error) {
    console.error("[PATCH /v1/org-settings] failed:", error);
    return c.json({ error: "upsert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateOrgSettingsResponse = {
    settings: { showDriverPay: nextShowDriverPay, rateConSettings: mergedRateCon },
  };
  return c.json(res);
});

export default orgSettings;
