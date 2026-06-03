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
import { bucketReadOrder } from "../lib/docBuckets.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const documents = new Hono<{ Variables: AuthVariables }>();

documents.get("/:id/url", async (c) => {
  const orgId = c.get("orgId");
  const docId = c.req.param("id");

  const { data, error } = await supabase
    .from("load_documents")
    .select("storage_path, kind")
    .eq("id", docId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/documents/:id/url] read failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const row = data as { storage_path: string; kind: string };
  // Try the canonical bucket for this kind first; fall through to the
  // other bucket for legacy rate_con rows that haven't been migrated.
  for (const bucket of bucketReadOrder(row.kind)) {
    const { data: signed } = await supabase.storage
      .from(bucket)
      .createSignedUrl(row.storage_path, 3600);
    if (signed) {
      const res: GetDocumentUrlResponse = { url: signed.signedUrl };
      return c.json(res);
    }
  }
  console.error("[GET /v1/documents/:id/url] sign failed in all candidate buckets", { docId, path: row.storage_path });
  return c.json({ error: "sign_failed" } satisfies ApiErrorResponse, 500);
});

// PATCH /v1/documents/:id — rename and/or recategorize a document.
// Either fileName or kind (or both) may be supplied; sending neither
// returns 400. When ONLY kind changes, the server also auto-renames
// the display fileName to match the new kind (matching the auto-
// naming applied at upload time) — flipping POD → BOL takes
// "45280_POD.pdf" to "45280_BOL.pdf" without forcing the caller to
// recompute the name client-side.
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

  if (hasKind && !DOCUMENT_KINDS.includes(body.kind as DocumentKind)) {
    return c.json(
      {
        error:  "validation_failed",
        errors: [`kind must be one of ${DOCUMENT_KINDS.join("|")}`],
      } satisfies ApiErrorResponse,
      400,
    );
  }

  // Read the current row so we can (a) check if the kind actually
  // changed and (b) compute a new filename matching the upload-time
  // convention. Without this we'd silently apply a no-op kind update
  // and miss the auto-rename opportunity.
  const { data: existing, error: readErr } = await supabase
    .from("load_documents")
    .select("file_name, kind, load_id")
    .eq("id", docId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (readErr) {
    console.error("[PATCH /v1/documents/:id] read failed:", readErr);
    return c.json({ error: "fetch_failed", detail: readErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const row = existing as { file_name: string; kind: string; load_id: string | null };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};
  let cleanName: string | undefined;
  if (hasName) {
    if (!body.fileName!.trim()) {
      return c.json({ error: "validation_failed", errors: ["fileName empty"] } satisfies ApiErrorResponse, 400);
    }
    // Strip path separators so a rename can't escape the storage
    // layer. We only touch the display name on the row, not the
    // storage_path itself.
    cleanName = body.fileName!.trim().replace(/[/\\]/g, "_").slice(0, 200);
    updates.file_name = cleanName;
  }
  if (hasKind) {
    updates.kind = body.kind;
    // Auto-rename when the caller changed kind but didn't pass an
    // explicit fileName. Matches the {LOAD_NUM}_{KIND}{_N}.{ext}
    // convention used by both upload routes (loads.ts + driver.ts).
    // Skipped when kind didn't actually change (no-op PATCH).
    if (!hasName && body.kind !== row.kind && row.load_id) {
      const { data: loadInfo } = await supabase
        .from("loads")
        .select("load_num")
        .eq("id", row.load_id)
        .eq("org_id", orgId)
        .maybeSingle();
      const loadNum = (loadInfo as { load_num: string | null } | null)?.load_num ?? null;
      const ext = row.file_name.includes(".") ? row.file_name.split(".").pop()! : "pdf";
      if (loadNum) {
        const safeNum = loadNum.replace(/[^A-Za-z0-9_-]/g, "");
        const kindLabel = String(body.kind).toUpperCase();
        // Suffix _N when the load already has another doc of the
        // new kind so the rename doesn't clobber the display name
        // of an existing row. Excludes the doc being updated from
        // the count.
        const { count: priorCount } = await supabase
          .from("load_documents")
          .select("id", { head: true, count: "exact" })
          .eq("load_id", row.load_id)
          .eq("org_id", orgId)
          .eq("kind", body.kind as string)
          .neq("id", docId);
        const suffix = (priorCount ?? 0) > 0 ? `_${(priorCount ?? 0) + 1}` : "";
        cleanName = `${safeNum}_${kindLabel}${suffix}.${ext}`;
        updates.file_name = cleanName;
      }
    }
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
  // Belt-and-suspenders: explicitly recompute loads.document_counts
  // after a kind change. The AFTER UPDATE trigger
  // (`load_documents_refresh_counts`) is supposed to do this, but
  // we've seen stale counts in production where receipts show as
  // "RC ×3" in the badge column — most likely because the trigger
  // didn't fire (legacy data, migration not applied, etc.). Manually
  // re-aggregating here makes the count match the actual kind values
  // immediately for this load, no matter the trigger state.
  if (hasKind && row.load_id) {
    try {
      const { data: agg } = await supabase
        .from("load_documents")
        .select("kind")
        .eq("load_id", row.load_id)
        .eq("org_id", orgId);
      const next: Record<string, number> = {};
      for (const r of (agg ?? []) as Array<{ kind: string }>) {
        next[r.kind] = (next[r.kind] ?? 0) + 1;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await supabase
        .from("loads")
        .update({ document_counts: next } as any)
        .eq("id", row.load_id)
        .eq("org_id", orgId);
    } catch (recountErr) {
      // Non-fatal — the kind change landed; the badge column will
      // self-heal once the trigger fires on the next mutation.
      console.warn("[PATCH /v1/documents/:id] document_counts re-aggregate failed:", recountErr);
    }
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
    .select("storage_path, kind")
    .eq("id", docId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr) {
    console.error("[DELETE /v1/documents/:id] read failed:", fetchErr);
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const row = data as { storage_path: string; kind: string };
  const { error: delErr } = await supabase
    .from("load_documents")
    .delete()
    .eq("id", docId)
    .eq("org_id", orgId);
  if (delErr) {
    console.error("[DELETE /v1/documents/:id] row delete failed:", delErr);
    return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
  }
  // Try deleting from both candidate buckets — the actual blob lives
  // in exactly one of them, the other returns 404 which is harmless.
  // Orphan blobs (if both removes fail) are tolerable; we'd rather
  // leave a stray file than block the row delete on storage.
  for (const bucket of bucketReadOrder(row.kind)) {
    const { error: blobErr } = await supabase.storage.from(bucket).remove([row.storage_path]);
    if (!blobErr) break;
  }

  return c.json({ ok: true });
});

export default documents;
