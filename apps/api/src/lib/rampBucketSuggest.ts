/**
 * Bucket suggestions for uncategorized Ramp card transactions, learned
 * from how the org has already filed its card spend — no fixed mapping.
 *
 *   1. Same merchant, same cardholder  (Amazon by Jordy → Trucks)
 *   2. Same merchant                   (Hotel Engine → Hotels)
 *   3. Same Ramp category              (Lodging → Hotels)
 *
 * Each step needs a clear majority so a split history doesn't produce a
 * coin-flip suggestion; the reason string carries the counts so the
 * person accepting it can see how sure it is.
 */

import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

export interface BucketSuggestion {
  bucketId: string;
  reason:   string;
}

export interface SuggestInput {
  merchantName:   string | null;
  skCategoryName: string | null;
  cardholderName: string | null;
}

const MIN_SHARE = 0.6;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

type Tally = Map<string, number>;

function top(t: Tally | undefined): { bucketId: string; n: number; of: number } | null {
  if (!t) return null;
  let best: string | null = null; let n = 0; let of = 0;
  for (const [b, c] of t) { of += c; if (c > n) { best = b; n = c; } }
  return best && n / of >= MIN_SHARE ? { bucketId: best, n, of } : null;
}

/** Loads the org's categorized Ramp history once; returns a pure lookup. */
export async function loadRampSuggester(
  orgId: string, liveBucketIds: Set<string>,
): Promise<(tx: SuggestInput) => BucketSuggestion | null> {
  const rows = await fetchAllRows<{ merchant_name: string | null; sk_category_name: string | null; cardholder_name: string | null; bucket_id: string }>(
    "ramp suggest history", () => supabase
      .from("ramp_transactions")
      .select("merchant_name, sk_category_name, cardholder_name, bucket_id")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("bucket_id", "is", null));

  const byMerchant = new Map<string, Tally>();
  const byMerchantHolder = new Map<string, Tally>();
  const byCategory = new Map<string, Tally>();
  const bump = (m: Map<string, Tally>, key: string, bucketId: string) => {
    if (!key) return;
    const t = m.get(key) ?? new Map<string, number>();
    t.set(bucketId, (t.get(bucketId) ?? 0) + 1);
    m.set(key, t);
  };
  for (const r of rows) {
    if (!liveBucketIds.has(r.bucket_id)) continue;
    const merchant = norm(r.merchant_name);
    bump(byMerchant, merchant, r.bucket_id);
    if (merchant && r.cardholder_name) bump(byMerchantHolder, `${merchant}|${norm(r.cardholder_name)}`, r.bucket_id);
    bump(byCategory, norm(r.sk_category_name), r.bucket_id);
  }

  return (tx) => {
    const merchant = norm(tx.merchantName);
    const label = tx.merchantName?.trim() || "this merchant";
    const holder = top(byMerchantHolder.get(`${merchant}|${norm(tx.cardholderName)}`));
    if (holder) {
      return { bucketId: holder.bucketId, reason: `${holder.n} of ${holder.of} earlier ${label} charges by ${tx.cardholderName}` };
    }
    const byM = top(byMerchant.get(merchant));
    if (byM) return { bucketId: byM.bucketId, reason: `${byM.n} of ${byM.of} earlier ${label} charges` };
    const byC = top(byCategory.get(norm(tx.skCategoryName)));
    if (byC && byC.of >= 2) {
      return { bucketId: byC.bucketId, reason: `${byC.n} of ${byC.of} earlier ${tx.skCategoryName} charges` };
    }
    return null;
  };
}
