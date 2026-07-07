/**
 * /v1/ramp-transactions — read + manual-match endpoints for the Card
 * Spend board and per-asset ledger. Sync happens off the cron
 * (jobs/rampSyncSweep.ts); this router is read-mostly + one manual link.
 *
 * Module-gated on "maintenance" (Curzon-only rollout). Same capability
 * check as maintenance-reports so anyone who can see maintenance can
 * see spend.
 */

import { Hono } from "hono";
import type {
  RampTransaction,
  RampTransactionMatchStatus,
  RampAssetLinkSource,
  RampReceipt,
  ListRampTransactionsResponse,
  MatchRampTransactionRequest,
  MatchRampTransactionResponse,
  MarkRampNotApplicableResponse,
  RunRampSyncResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { runRampSyncSweep } from "../jobs/rampSyncSweep.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const TX_COLS = [
  "id", "org_id", "provider", "provider_transaction_id",
  "transacted_at", "amount", "currency",
  "merchant_name", "merchant_category_code", "sk_category_name",
  "memo", "receipts",
  "cardholder_ramp_user_id", "cardholder_name", "cardholder_email",
  "card_id", "card_last4",
  "asset_id", "trailer_id", "asset_link_source",
  "match_status", "match_confidence", "match_notes",
  "matched_at", "matched_by",
  "created_at", "updated_at",
].join(", ");

interface RampTransactionRow {
  id:                       string;
  org_id:                   string;
  provider:                 string;
  provider_transaction_id:  string;
  transacted_at:            string;
  amount:                   string | number;
  currency:                 string;
  merchant_name:            string | null;
  merchant_category_code:   string | null;
  sk_category_name:         string | null;
  memo:                     string | null;
  receipts:                 RampReceipt[] | null;
  cardholder_ramp_user_id:  string | null;
  cardholder_name:          string | null;
  cardholder_email:         string | null;
  card_id:                  string | null;
  card_last4:               string | null;
  asset_id:                 number | null;
  trailer_id:               number | null;
  asset_link_source:        string;
  match_status:             string;
  match_confidence:         number | null;
  match_notes:              string | null;
  matched_at:               string | null;
  matched_by:               string | null;
  created_at:               string;
  updated_at:               string | null;
}

function rowToTx(r: RampTransactionRow): RampTransaction {
  return {
    id:                     r.id,
    orgId:                  r.org_id,
    provider:               "ramp",
    providerTransactionId:  r.provider_transaction_id,
    transactedAt:           r.transacted_at,
    amount:                 Number(r.amount),
    currency:               r.currency,
    merchantName:           r.merchant_name          ?? undefined,
    merchantCategoryCode:   r.merchant_category_code ?? undefined,
    skCategoryName:         r.sk_category_name       ?? undefined,
    memo:                   r.memo                   ?? undefined,
    receipts:               r.receipts               ?? [],
    cardholderRampUserId:   r.cardholder_ramp_user_id ?? undefined,
    cardholderName:         r.cardholder_name        ?? undefined,
    cardholderEmail:        r.cardholder_email       ?? undefined,
    cardId:                 r.card_id                ?? undefined,
    cardLast4:              r.card_last4             ?? undefined,
    assetId:                r.asset_id               ?? undefined,
    trailerId:              r.trailer_id             ?? undefined,
    assetLinkSource:        r.asset_link_source as RampAssetLinkSource,
    matchStatus:            r.match_status as RampTransactionMatchStatus,
    matchConfidence:        r.match_confidence       ?? undefined,
    matchNotes:             r.match_notes            ?? undefined,
    matchedAt:              r.matched_at             ?? undefined,
    matchedBy:              r.matched_by             ?? undefined,
    createdAt:              r.created_at,
    updatedAt:              r.updated_at             ?? undefined,
  };
}

const rampTx = new Hono<{ Variables: AuthVariables }>();

rampTx.use("*", requireModule("maintenance"), requireCapability("maintenance.access"));

// GET /v1/ramp-transactions — filterable list for the board.
rampTx.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const matchStatus      = url.searchParams.get("matchStatus");
  const assetId          = url.searchParams.get("assetId");
  const trailerId        = url.searchParams.get("trailerId");
  const cardholderUserId = url.searchParams.get("cardholderUserId");
  const category         = url.searchParams.get("category");
  const from             = url.searchParams.get("from");
  const to               = url.searchParams.get("to");
  const q                = url.searchParams.get("q");
  const limit  = Math.min(Math.max(Number(url.searchParams.get("limit")  ?? "100"), 1), 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);

  let query = supabase
    .from("ramp_transactions")
    .select(TX_COLS, { count: "exact" })
    .eq("org_id", orgId)
    .is("deleted_at", null);

  if (matchStatus && matchStatus !== "all") query = query.eq("match_status", matchStatus);
  if (assetId)                              query = query.eq("asset_id", Number(assetId));
  if (trailerId)                            query = query.eq("trailer_id", Number(trailerId));
  if (cardholderUserId)                     query = query.eq("cardholder_ramp_user_id", cardholderUserId);
  if (category)                             query = query.eq("sk_category_name", category);
  if (from)                                 query = query.gte("transacted_at", from);
  if (to)                                   query = query.lte("transacted_at", to);
  if (q && q.trim().length >= 2) {
    // Escape PostgREST .or() control chars (% , ( )) — same guard as
    // fuel-transactions and loads/search.
    const term = q.trim().replace(/[%,()]/g, "\\$&");
    query = query.or(
      `memo.ilike.%${term}%,` +
      `merchant_name.ilike.%${term}%,` +
      `cardholder_name.ilike.%${term}%,` +
      `provider_transaction_id.ilike.%${term}%`,
    );
  }

  const { data, error, count } = await query
    .order("transacted_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    console.error("[GET /v1/ramp-transactions]", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as unknown as RampTransactionRow[]).map(rowToTx);
  const res: ListRampTransactionsResponse = {
    rampTransactions: rows,
    total:            count ?? rows.length,
    limit,
    offset,
  };
  return c.json(res);
});

// PATCH /v1/ramp-transactions/:id/match — manual asset link.
// Body: { assetId?, trailerId?, matchNotes? }. Pass both null to unlink.
rampTx.patch("/:id/match", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");
  const body = await c.req.json<MatchRampTransactionRequest>().catch(() => null);
  if (!body) {
    return c.json({ error: "bad_request", detail: "invalid json body" } satisfies ApiErrorResponse, 400);
  }
  const assetId   = body.assetId   ?? null;
  const trailerId = body.trailerId ?? null;
  if (assetId != null && trailerId != null) {
    return c.json({ error: "bad_request", detail: "cannot set both assetId and trailerId" } satisfies ApiErrorResponse, 400);
  }

  const isUnlink = assetId == null && trailerId == null;
  const updateRow: Record<string, unknown> = isUnlink
    ? {
        asset_id: null,
        trailer_id: null,
        asset_link_source: "none",
        match_status: "unmatched",
        match_confidence: null,
        match_notes: body.matchNotes ?? null,
        matched_at: null,
        matched_by: null,
      }
    : {
        asset_id: assetId,
        trailer_id: trailerId,
        asset_link_source: "manual",
        match_status: "manual_matched",
        match_confidence: 100,
        match_notes: body.matchNotes ?? null,
        matched_at: new Date().toISOString(),
        matched_by: userId,
      };

  const { data, error } = await supabase
    .from("ramp_transactions")
    .update(updateRow)
    .eq("id", id).eq("org_id", orgId)
    .select(TX_COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "update_failed", detail: error?.message ?? "not_found" } satisfies ApiErrorResponse, 500);
  }
  const res: MatchRampTransactionResponse = {
    rampTransaction: rowToTx(data as unknown as RampTransactionRow),
  };
  return c.json(res);
});

// PATCH /v1/ramp-transactions/:id/mark-not-applicable — stop showing
// this in "Needs review" without forcing an asset link (subscriptions,
// bank fees, etc.).
rampTx.patch("/:id/mark-not-applicable", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");
  const { data, error } = await supabase
    .from("ramp_transactions")
    .update({
      match_status: "not_applicable",
      asset_id: null,
      trailer_id: null,
      asset_link_source: "none",
      match_confidence: null,
      match_notes: "Marked not applicable",
      matched_at: new Date().toISOString(),
      matched_by: userId,
    })
    .eq("id", id).eq("org_id", orgId)
    .select(TX_COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "update_failed", detail: error?.message ?? "not_found" } satisfies ApiErrorResponse, 500);
  }
  const res: MarkRampNotApplicableResponse = {
    rampTransaction: rowToTx(data as unknown as RampTransactionRow),
  };
  return c.json(res);
});

// POST /v1/ramp-transactions/sync — kick the sweep on demand (parallels
// Mudflap's manual sync button on the equipment page).
rampTx.post("/sync", async (c) => {
  try {
    const r = await runRampSyncSweep();
    const res: RunRampSyncResponse = {
      ok: true,
      skipped: r.skipped,
      reason: r.reason,
      orgId: r.orgId,
      from: r.from,
      to: r.to,
      result: r.result ? {
        fetched:       r.result.fetched,
        inserted:      r.result.inserted,
        updated:       r.result.updated,
        duplicates:    r.result.duplicates,
        failed:        r.result.failed,
        autoMatched:   r.result.autoMatched,
        notApplicable: r.result.notApplicable,
      } : undefined,
    };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: "sync_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

export default rampTx;
