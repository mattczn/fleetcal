/**
 * /v1/documents — driver-uploaded document URLs.
 *
 * Endpoints:
 *   GET /v1/documents/:id/url — fresh 1-hour signed URL
 *
 * Listing happens via load scope: GET /v1/loads/:loadId/documents
 * (defined in routes/loads.ts).
 *
 * Upload + delete from this server are intentionally not provided yet —
 * the driver app uploads directly to Storage today, and web doesn't
 * upload load documents. Add when those flows route through Railway.
 */

import { Hono } from "hono";
import {
  type GetDocumentUrlResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const documents = new Hono<{ Variables: AuthVariables }>();

documents.get("/:id/url", async (c) => {
  const orgId = c.get("orgId");
  const docId = c.req.param("id");

  const { data, error } = await supabase
    .from("load_documents")
    .select("storage_path")
    .eq("id", docId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/documents/:id/url] read failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const path = (data as { storage_path: string }).storage_path;
  const { data: signed, error: signErr } = await supabase.storage
    .from("load-documents")
    .createSignedUrl(path, 3600);
  if (signErr || !signed) {
    console.error("[GET /v1/documents/:id/url] sign failed:", signErr);
    return c.json({ error: "sign_failed", detail: signErr?.message } satisfies ApiErrorResponse, 500);
  }
  const res: GetDocumentUrlResponse = { url: signed.signedUrl };
  return c.json(res);
});

export default documents;
