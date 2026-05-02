/**
 * /v1/org-settings — per-org preferences.
 *
 * Defaults when no row exists yet:
 *   showDriverPay = false
 *
 * Other org_settings columns (motive_api_key etc.) are intentionally not
 * exposed here — they're read by server-side proxies only.
 */

import { Hono } from "hono";
import {
  type GetOrgSettingsResponse,
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
    .select("show_driver_pay")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/org-settings] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const showDriverPay = (data as { show_driver_pay: boolean } | null)?.show_driver_pay ?? false;
  const res: GetOrgSettingsResponse = { settings: { showDriverPay } };
  return c.json(res);
});

orgSettings.patch("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<UpdateOrgSettingsRequest>();
  if (typeof body.showDriverPay !== "boolean") {
    return c.json({ error: "validation_failed", errors: ["showDriverPay (boolean) required"] } satisfies ApiErrorResponse, 400);
  }
  const { error } = await supabase
    .from("org_settings")
    .upsert(
      { org_id: orgId, show_driver_pay: body.showDriverPay } as never,
      { onConflict: "org_id" },
    );
  if (error) {
    console.error("[PATCH /v1/org-settings] failed:", error);
    return c.json({ error: "upsert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateOrgSettingsResponse = { settings: { showDriverPay: body.showDriverPay } };
  return c.json(res);
});

export default orgSettings;
