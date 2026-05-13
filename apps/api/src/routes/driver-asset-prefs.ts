/**
 * /v1/driver-asset-prefs — preferred-driver-per-asset mapping.
 *
 * Schema enforces one preferred driver per asset (PK = asset_id).
 *
 * Endpoints:
 *   GET    /v1/driver-asset-prefs             — list all prefs for the org
 *   PUT    /v1/driver-asset-prefs/:assetId    — set/update preferred driver
 *   DELETE /v1/driver-asset-prefs/:assetId    — clear preference
 */

import { Hono } from "hono";
import {
  type ListDriverAssetPrefsResponse,
  type SetDriverAssetPrefRequest,
  type SetDriverAssetPrefResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const prefs = new Hono<{ Variables: AuthVariables }>();

prefs.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("driver_asset_prefs")
    .select("asset_id,driver_id")
    .eq("org_id", orgId);
  if (error) {
    console.error("[GET /v1/driver-asset-prefs] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListDriverAssetPrefsResponse = {
    prefs: ((data ?? []) as Array<{ asset_id: number; driver_id: number }>).map((r) => ({
      assetId:  r.asset_id,
      driverId: r.driver_id,
    })),
  };
  return c.json(res);
});

prefs.put("/:assetId", requireCapability("drivers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const assetId = Number(c.req.param("assetId"));
  if (!Number.isFinite(assetId)) {
    return c.json({ error: "validation_failed", errors: ["assetId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<SetDriverAssetPrefRequest>();
  if (!Number.isFinite(body?.driverId)) {
    return c.json({ error: "validation_failed", errors: ["driverId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { error } = await supabase
    .from("driver_asset_prefs")
    .upsert(
      { asset_id: assetId, driver_id: body.driverId, org_id: orgId } as never,
      { onConflict: "asset_id" },
    );
  if (error) {
    console.error("[PUT /v1/driver-asset-prefs/:assetId] failed:", error);
    return c.json({ error: "upsert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: SetDriverAssetPrefResponse = { pref: { assetId, driverId: body.driverId } };
  return c.json(res);
});

prefs.delete("/:assetId", requireCapability("drivers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const assetId = Number(c.req.param("assetId"));
  if (!Number.isFinite(assetId)) {
    return c.json({ error: "validation_failed", errors: ["assetId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { error } = await supabase
    .from("driver_asset_prefs")
    .delete()
    .eq("asset_id", assetId)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/driver-asset-prefs/:assetId] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default prefs;
