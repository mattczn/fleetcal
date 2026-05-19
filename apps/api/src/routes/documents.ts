/**
 * /v1/documents — driver-uploaded document URLs.
 *
 * Endpoints:
 *   GET    /v1/documents/:id/url  — fresh 1-hour signed URL
 *   PATCH  /v1/documents/:id      — rename (file_name only for now)
 *   DELETE /v1/documents/:id      — remove the row + storage blob
 *
 * Listing happens via load scope: GET /v1/loads/:loadId/documents
 * Uploads happen via POST /v1/loads/:loadId/documents (loads.ts) or
 * POST /v1/driver/loads/:id/documents (driver.ts).
 */

import { Hono } from "hono";
import {
  type GetDocumentUrlResponse,
  type ApiErrorResponse,
  type DocumentKind,
  DOCUMENT_KINDS,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

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

// PATCH /v1/documents/:id — rename and/or recategorize a document.
// Either fileName or kind (or both) may be supplied; sending neither
// returns 400. Kind changes can affect the closeout checklist (e.g.
// flipping a doc from BOL → POD shifts what counts toward the release
// gate); we still allow it because the user need outweighs the cost
// of an occasionally-stale checklist read until the next refetch.
documents.patch("/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const docId = c.req.param("id");
  const body = await c.req.json<{ fileName?: string; kind?: string }>();

  const hasName = body.fileName !== undefined && body.fileName !== null;
  const hasKind = body.kind !== undefined && body.kind !== null;
  if (!hasName && !hasKind) {
    return c.json(
      { error: "validation_failed", errors: ["fileName or kind required"] } satisfies ApiErrorResponse,
      400,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};
  let cleanName: string | undefined;
  if (hasName) {
    if (!body.fileName!.trim()) {
      return c.json({ error: "validation_failed", errors: ["fileName empty"] } satisfies ApiErrorResponse, 400);
    }
    // Strip path separators so a rename can't escape the storage layer.
    // We're not touching storage_path here — only the display name on
    // the row — so this is belt-and-suspenders.
    cleanName = body.fileName!.trim().replace(/[/\\]/g, "_").slice(0, 200);
    updates.file_name = cleanName;
  }
  if (hasKind) {
    if (!DOCUMENT_KINDS.includes(body.kind as DocumentKind)) {
      return c.json(
        {
          error:  "validation_failed",
          errors: [`kind must be one of ${DOCUMENT_KINDS.join("|")}`],
        } satisfies ApiErrorResponse,
        400,
      );
    }
    updates.kind = body.kind;
  }

  const { error } = await supabase
    .from("load_documents")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(updates as any)
    .eq("id", docId)
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/documents/:id] update failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({
    ok: true,
    ...(cleanName !== undefined ? { fileName: cleanName } : {}),
    ...(hasKind ? { kind: body.kind } : {}),
  });
});

// DELETE /v1/documents/:id — remove the row + storage object. Orphan
// blobs are cleaner than half-deleted rows, so we tolerate (and log) a
// storage-remove failure rather than rolling back the row delete.
documents.delete("/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const docId = c.req.param("id");

  const { data, error: fetchErr } = await supabase
    .from("load_documents")
    .select("storage_path")
    .eq("id", docId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr) {
    console.error("[DELETE /v1/documents/:id] read failed:", fetchErr);
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const path = (data as { storage_path: string }).storage_path;
  const { error: delErr } = await supabase
    .from("load_documents")
    .delete()
    .eq("id", docId)
    .eq("org_id", orgId);
  if (delErr) {
    console.error("[DELETE /v1/documents/:id] row delete failed:", delErr);
    return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
  }
  const { error: blobErr } = await supabase.storage.from("load-documents").remove([path]);
  if (blobErr) console.warn("[DELETE /v1/documents/:id] storage remove failed (orphan blob ok):", blobErr);

  return c.json({ ok: true });
});

export default documents;
