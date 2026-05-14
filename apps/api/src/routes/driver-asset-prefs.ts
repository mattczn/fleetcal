/**
 * /v1/driver-asset-prefs — preferred-driver-per-asset mapping.
 *
 * Schema: one row per asset (PK = asset_id) with up to TWO drivers:
 *   - driver_id           = primary driver (the truck owner)
 *   - secondary_driver_id = optional second driver who shares the asset
 *
 * Endpoints:
 *   GET    /v1/driver-asset-prefs             — list all prefs for the org
 *   PUT    /v1/driver-asset-prefs/:assetId    — set/update either driver slot
 *   DELETE /v1/driver-asset-prefs/:assetId    — clear the whole row
 *
 * PUT body fields are independently optional:
 *   { driverId: 12 }                         → set primary, leave secondary alone
 *   { secondaryDriverId: 7 }                 → set secondary, leave primary alone
 *   { driverId: 12, secondaryDriverId: 7 }   → set both
 *   { driverId: null }                       → clear primary
 *   { driverId: null, secondaryDriverId: null } → server deletes the row
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
  // secondary_driver_id was added by 20260516_secondary_driver.sql.
  // Supabase generated types may not include it until regenerated,
  // hence the unknown-cast pattern.
  const { data, error } = await supabase
    .from("driver_asset_prefs")
    .select("asset_id,driver_id,secondary_driver_id" as never)
    .eq("org_id", orgId);
  if (error) {
    console.error("[GET /v1/driver-asset-prefs] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = (data ?? []) as unknown as Array<{ asset_id: number; driver_id: number | null; secondary_driver_id: number | null }>;
  const res: ListDriverAssetPrefsResponse = {
    prefs: rows.map((r) => ({
      assetId:           r.asset_id,
      driverId:          r.driver_id,
      secondaryDriverId: r.secondary_driver_id,
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
  // Validate any provided IDs are numeric (null is allowed = clear slot).
  if (body.driverId !== undefined && body.driverId !== null && !Number.isFinite(body.driverId)) {
    return c.json({ error: "validation_failed", errors: ["driverId must be numeric or null"] } satisfies ApiErrorResponse, 400);
  }
  if (body.secondaryDriverId !== undefined && body.secondaryDriverId !== null && !Number.isFinite(body.secondaryDriverId)) {
    return c.json({ error: "validation_failed", errors: ["secondaryDriverId must be numeric or null"] } satisfies ApiErrorResponse, 400);
  }
  if (body.driverId === undefined && body.secondaryDriverId === undefined) {
    return c.json({ error: "validation_failed", errors: ["at least one of driverId or secondaryDriverId required"] } satisfies ApiErrorResponse, 400);
  }

  // Read existing row so PUT can patch a single slot without clobbering
  // the other.
  const { data: existing } = await supabase
    .from("driver_asset_prefs")
    .select("driver_id,secondary_driver_id" as never)
    .eq("asset_id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  const prev = existing as unknown as { driver_id: number | null; secondary_driver_id: number | null } | null;

  const nextPrimary   = body.driverId          === undefined ? (prev?.driver_id           ?? null) : body.driverId;
  const nextSecondary = body.secondaryDriverId === undefined ? (prev?.secondary_driver_id ?? null) : body.secondaryDriverId;

  // If both are null, delete the row instead of holding an empty pref.
  if (nextPrimary === null && nextSecondary === null) {
    const { error: delErr } = await supabase
      .from("driver_asset_prefs")
      .delete()
      .eq("asset_id", assetId)
      .eq("org_id", orgId);
    if (delErr) {
      console.error("[PUT /v1/driver-asset-prefs/:assetId] delete-empty failed:", delErr);
      return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
    }
    const res: SetDriverAssetPrefResponse = { pref: { assetId, driverId: null, secondaryDriverId: null } };
    return c.json(res);
  }

  const { error } = await supabase
    .from("driver_asset_prefs")
    .upsert(
      {
        asset_id:            assetId,
        driver_id:           nextPrimary,
        secondary_driver_id: nextSecondary,
        org_id:              orgId,
      } as never,
      { onConflict: "asset_id" },
    );
  if (error) {
    console.error("[PUT /v1/driver-asset-prefs/:assetId] failed:", error);
    return c.json({ error: "upsert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: SetDriverAssetPrefResponse = {
    pref: { assetId, driverId: nextPrimary, secondaryDriverId: nextSecondary },
  };
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
