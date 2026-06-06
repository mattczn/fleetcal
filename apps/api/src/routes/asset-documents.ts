/**
 * /v1/asset-documents/:id — per-document operations for truck docs.
 *
 * Listing + uploading happens through /v1/assets/:id/documents
 * (mounted in assets.ts). This route handles the per-doc fresh-URL
 * and delete operations.
 *
 * Mirror of driver-documents.ts.
 */
import { Hono } from "hono";
import {
  type ApiErrorResponse,
  type GetAssetDocumentUrlResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { ASSET_DOC_BUCKET } from "./assets.js";

const assetDocuments = new Hono<{ Variables: AuthVariables }>();

assetDocuments.get("/:id/url", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data, error } = await supabase
    .from("asset_documents")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const path = (data as { storage_path: string }).storage_path;
  const { data: signed } = await supabase.storage.from(ASSET_DOC_BUCKET).createSignedUrl(path, 3600);
  if (!signed) return c.json({ error: "sign_failed" } satisfies ApiErrorResponse, 500);
  const res: GetAssetDocumentUrlResponse = { url: signed.signedUrl };
  return c.json(res);
});

assetDocuments.delete("/:id", requireCapability("assets.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data } = await supabase
    .from("asset_documents")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const path = (data as { storage_path: string } | null)?.storage_path;

  const { error } = await supabase
    .from("asset_documents")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/asset-documents/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (path) void supabase.storage.from(ASSET_DOC_BUCKET).remove([path]);
  return c.json({ ok: true });
});

export default assetDocuments;
