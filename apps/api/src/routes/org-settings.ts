/**
 * /v1/org-settings — per-org preferences.
 *
 * Defaults when no row exists yet:
 *   showDriverPay  = false
 *   rateConSettings = {} (empty; client falls back to its built-in defaults)
 *   invoiceSettings = {}
 *   roleOverrides  = {} (no overrides; defaults from @fleetcal/types/permissions apply)
 *
 * Other org_settings columns (motive_api_key etc.) are intentionally not
 * exposed here — they're read by server-side proxies only.
 */

import { Hono } from "hono";
import {
  type GetOrgSettingsResponse,
  type RateConSettings,
  type InvoiceSettings,
  type RoleOverrides,
  type UpdateOrgSettingsRequest,
  type UpdateOrgSettingsResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, invalidateRoleOverrides } from "../middleware/require.js";

const orgSettings = new Hono<{ Variables: AuthVariables }>();

orgSettings.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("org_settings")
    .select("show_driver_pay,rate_con_settings,invoice_settings,role_overrides")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/org-settings] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const row = data as {
    show_driver_pay:   boolean;
    rate_con_settings: RateConSettings | null;
    invoice_settings:  InvoiceSettings  | null;
    role_overrides:    RoleOverrides    | null;
  } | null;
  const res: GetOrgSettingsResponse = {
    settings: {
      showDriverPay:   row?.show_driver_pay   ?? false,
      rateConSettings: row?.rate_con_settings ?? {},
      invoiceSettings: row?.invoice_settings  ?? {},
      roleOverrides:   row?.role_overrides    ?? {},
    },
  };
  return c.json(res);
});

orgSettings.patch("/", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<UpdateOrgSettingsRequest>();
  // At least one allowed key must be present.
  if (
    body.showDriverPay   === undefined &&
    body.rateConSettings === undefined &&
    body.invoiceSettings === undefined &&
    body.roleOverrides   === undefined
  ) {
    return c.json({ error: "validation_failed", errors: ["at least one settable field required"] } satisfies ApiErrorResponse, 400);
  }

  // Read existing row first so we can patch the JSONB partially without
  // clobbering keys the caller didn't include.
  const { data: existing } = await supabase
    .from("org_settings")
    .select("show_driver_pay,rate_con_settings,invoice_settings,role_overrides")
    .eq("org_id", orgId)
    .maybeSingle();
  const existingRow = existing as {
    show_driver_pay:   boolean;
    rate_con_settings: RateConSettings | null;
    invoice_settings:  InvoiceSettings  | null;
    role_overrides:    RoleOverrides    | null;
  } | null;

  const nextShowDriverPay = body.showDriverPay ?? existingRow?.show_driver_pay ?? false;
  // Each JSONB column patches by spread-merge so the caller can update
  // a single field without re-sending the rest.
  const mergedRateCon: RateConSettings = body.rateConSettings === undefined
    ? (existingRow?.rate_con_settings ?? {})
    : { ...(existingRow?.rate_con_settings ?? {}), ...(body.rateConSettings ?? {}) };
  const mergedInvoice: InvoiceSettings = body.invoiceSettings === undefined
    ? (existingRow?.invoice_settings ?? {})
    : { ...(existingRow?.invoice_settings ?? {}), ...(body.invoiceSettings ?? {}) };
  // roleOverrides is a full REPLACE, not a merge — admins toggling
  // a single cell still send the whole map. Trying to merge per-role
  // dicts would make "remove an override" awkward (you'd have to
  // send a sentinel value).
  const nextRoleOverrides: RoleOverrides = body.roleOverrides === undefined
    ? (existingRow?.role_overrides ?? {})
    : (body.roleOverrides ?? {});

  const { error } = await supabase
    .from("org_settings")
    .upsert(
      {
        org_id:            orgId,
        show_driver_pay:   nextShowDriverPay,
        rate_con_settings: mergedRateCon as never,
        invoice_settings:  mergedInvoice as never,
        role_overrides:    nextRoleOverrides as never,
      } as never,
      { onConflict: "org_id" },
    );
  if (error) {
    console.error("[PATCH /v1/org-settings] failed:", error);
    return c.json({ error: "upsert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  // Bust the in-memory role-override cache for this org so the new
  // values take effect on the very next request, not after the TTL.
  if (body.roleOverrides !== undefined) {
    invalidateRoleOverrides(orgId);
  }
  const res: UpdateOrgSettingsResponse = {
    settings: {
      showDriverPay:   nextShowDriverPay,
      rateConSettings: mergedRateCon,
      invoiceSettings: mergedInvoice,
      roleOverrides:   nextRoleOverrides,
    },
  };
  return c.json(res);
});

export default orgSettings;
