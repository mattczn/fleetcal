/**
 * /v1/trailer-documents/:id — per-document operations for trailer docs.
 *
 * Listing + uploading happens through /v1/trailers/:id/documents
 * (mounted in trailers.ts). This route handles the per-doc fresh-URL
 * and delete operations.
 *
 * Mirror of asset-documents.ts / driver-documents.ts.
 */
import { Hono } from "hono";
import {
  type ApiErrorResponse,
  type GetTrailerDocumentUrlResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { TRAILER_DOC_BUCKET } from "./trailers.js";

const trailerDocuments = new Hono<{ Variables: AuthVariables }>();

trailerDocuments.get("/:id/url", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data, error } = await supabase
    .from("trailer_documents")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const path = (data as { storage_path: string }).storage_path;
  const { data: signed } = await supabase.storage.from(TRAILER_DOC_BUCKET).createSignedUrl(path, 3600);
  if (!signed) return c.json({ error: "sign_failed" } satisfies ApiErrorResponse, 500);
  const res: GetTrailerDocumentUrlResponse = { url: signed.signedUrl };
  return c.json(res);
});

trailerDocuments.delete("/:id", requireCapability("trailers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data } = await supabase
    .from("trailer_documents")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const path = (data as { storage_path: string } | null)?.storage_path;

  const { error } = await supabase
    .from("trailer_documents")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/trailer-documents/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (path) void supabase.storage.from(TRAILER_DOC_BUCKET).remove([path]);
  return c.json({ ok: true });
});

export default trailerDocuments;
