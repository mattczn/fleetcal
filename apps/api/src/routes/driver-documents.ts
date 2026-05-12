/**
 * /v1/driver-documents/:id — per-document operations.
 *
 * Listing + uploading happens through /v1/drivers/:id/documents
 * (ops) and /v1/driver/documents (driver self). This route is for
 * the per-doc fresh-URL + delete operations, used by both surfaces.
 */
import { Hono } from "hono";
import {
  type ApiErrorResponse,
  type GetDriverDocumentUrlResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { DRIVER_DOC_BUCKET } from "./drivers.js";

const driverDocuments = new Hono<{ Variables: AuthVariables }>();

// GET /v1/driver-documents/:id/url — 1-hour signed URL
driverDocuments.get("/:id/url", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data, error } = await supabase
    .from("driver_documents")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const path = (data as { storage_path: string }).storage_path;
  const { data: signed } = await supabase.storage.from(DRIVER_DOC_BUCKET).createSignedUrl(path, 3600);
  if (!signed) return c.json({ error: "sign_failed" } satisfies ApiErrorResponse, 500);
  const res: GetDriverDocumentUrlResponse = { url: signed.signedUrl };
  return c.json(res);
});

// DELETE /v1/driver-documents/:id
driverDocuments.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data } = await supabase
    .from("driver_documents")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const path = (data as { storage_path: string } | null)?.storage_path;

  const { error } = await supabase
    .from("driver_documents")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/driver-documents/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (path) void supabase.storage.from(DRIVER_DOC_BUCKET).remove([path]);
  return c.json({ ok: true });
});

export default driverDocuments;
