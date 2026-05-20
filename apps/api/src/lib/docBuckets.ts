/**
 * Single source of truth for which storage bucket each DocumentKind
 * lives in. The split exists for security: rate cons contain broker
 * rates and are dispatcher-confidential, so they get a separate
 * bucket from everything drivers can see.
 *
 *   - rate_con  → "rate-cons"      (dispatcher-only)
 *   - all else  → "load-documents" (drivers may see based on visibility)
 *
 * Read paths SHOULD prefer `bucketForKind(doc.kind)`. The dual-bucket
 * fallback below exists for the migration window — some legacy
 * rate_con rows still have their blob in `load-documents` from before
 * the split. Once the one-shot migration in scripts/move-rate-cons.ts
 * runs against production, the fallback is purely defensive.
 *
 * NOTE: invoice docs (kind="invoice") stay in load-documents today.
 * They're hidden from drivers via the visibility filter, not a bucket
 * split. If we ever need to physically isolate invoices the same way
 * we did rate cons, this is the file to touch.
 */
import type { DocumentKind } from "@fleetcal/types";

export const RATE_CON_BUCKET = "rate-cons" as const;
export const DOC_BUCKET      = "load-documents" as const;

export type DocBucket = typeof RATE_CON_BUCKET | typeof DOC_BUCKET;

/** Bucket where a doc of this kind should be WRITTEN. */
export function bucketForKind(kind: DocumentKind | string): DocBucket {
  return kind === "rate_con" ? RATE_CON_BUCKET : DOC_BUCKET;
}

/** Ordered bucket list for READ-side fallback. The primary bucket
 *  (by kind) is tried first; the secondary covers legacy rows.
 *  Returns a single bucket when there's no secondary to try. */
export function bucketReadOrder(kind: DocumentKind | string): DocBucket[] {
  return kind === "rate_con"
    ? [RATE_CON_BUCKET, DOC_BUCKET]
    : [DOC_BUCKET, RATE_CON_BUCKET];
}
