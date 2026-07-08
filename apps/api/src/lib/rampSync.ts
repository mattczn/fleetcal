/**
 * Ramp Developer API sync. Pulls card transactions into ramp_transactions
 * and runs rampMatcher over each memo. Mirrors mudflapCarriersSync: same
 * rolling-window pattern (idempotent via provider_transaction_id unique
 * constraint), same env-gated no-op when credentials are absent.
 *
 * OAuth2 client-credentials — tokens live ~15min so we cache in-process
 * with a 60s early-expiry buffer.
 *
 * Field parsing is defensive: Ramp's response shape is somewhat evolving
 * and we don't want a rename in one field to blow up ingest. Full row is
 * stored in raw_payload so a mis-named column can be backfilled from SQL
 * without re-pulling from Ramp.
 */

import { supabase } from "./supabase.js";
import {
  loadRampMatchInputs,
  matchMemo,
  type RampMatchInputs,
} from "./rampMatcher.js";
import { mapRampCategory } from "./rampCategoryMap.js";

const RAMP_BASE = process.env.RAMP_BASE_URL || "https://api.ramp.com/developer/v1";
const TOKEN_EARLY_EXPIRY_MS = 60_000;

interface CachedToken { accessToken: string; expiresAt: number; }
let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > TOKEN_EARLY_EXPIRY_MS) {
    return cachedToken.accessToken;
  }
  const clientId = process.env.RAMP_CLIENT_ID;
  const clientSecret = process.env.RAMP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("RAMP_CLIENT_ID/RAMP_CLIENT_SECRET not set");
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "transactions:read receipts:read users:read cards:read",
  });
  const res = await fetch(`${RAMP_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization:  `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept:         "application/json",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Ramp token ${res.status}: ${await res.text()}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: json.access_token,
    expiresAt:   now + Number(json.expires_in) * 1000,
  };
  return cachedToken.accessToken;
}

interface RampReceipt {
  receipt_id?: string;
  id?: string;
  url?: string;
}
interface RampCardHolder {
  user_id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  department_name?: string;
}
interface RampTransaction {
  id: string;
  amount: number;
  currency_code?: string;
  merchant_name?: string;
  merchant_category_code?: string;
  sk_category_name?: string;
  user_transaction_time?: string;
  memo?: string | null;
  card_holder?: RampCardHolder;
  card_id?: string;
  receipts?: RampReceipt[];
}
interface RampPage {
  data: RampTransaction[];
  page?: { next?: string | null };
}

async function fetchAllTransactions(
  token: string, from: string, to: string,
): Promise<RampTransaction[]> {
  // Ramp rejects date-only strings on from_date/to_date — it wants full
  // ISO 8601 datetimes. We accept YYYY-MM-DD from the sweep and expand
  // to start-of-day / end-of-day UTC here so callers don't need to care.
  const fromDt = /T/.test(from) ? from : `${from}T00:00:00Z`;
  const toDt   = /T/.test(to)   ? to   : `${to}T23:59:59Z`;
  const all: RampTransaction[] = [];
  const PAGE_SIZE = 100;
  let cursor: string | null = null;
  for (;;) {
    const url = new URL(`${RAMP_BASE}/transactions`);
    url.searchParams.set("from_date", fromDt);
    url.searchParams.set("to_date",   toDt);
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("start", cursor);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Ramp transactions ${res.status}: ${await res.text()}`);
    }
    const body = await res.json() as RampPage;
    all.push(...(body.data ?? []));
    const next = body.page?.next;
    if (!next) break;
    cursor = next;
  }
  return all;
}

export interface RampSyncResult {
  fetched:       number;
  inserted:      number;
  updated:       number;
  duplicates:    number;
  failed:        number;
  autoMatched:   number;
  notApplicable: number;
  failedSample:  Array<{ providerTransactionId: string; error: string }>;
}

function buildRow(
  orgId: string,
  tx: RampTransaction,
  inputs: RampMatchInputs,
) {
  const match = matchMemo(tx.memo, tx.sk_category_name ?? null, inputs);
  const cardholderName =
    [tx.card_holder?.first_name, tx.card_holder?.last_name]
      .filter(Boolean).join(" ").trim() || null;
  // Auto-derive expense_category from Ramp's own category. Manual
  // overrides are preserved on re-sync via the duplicate branch (only
  // NULL rows get refreshed).
  const expenseCategory = mapRampCategory(tx.sk_category_name);
  return {
    row: {
      org_id: orgId,
      provider: "ramp",
      provider_transaction_id: tx.id,
      transacted_at: tx.user_transaction_time ?? new Date().toISOString(),
      amount: tx.amount,
      currency: tx.currency_code ?? "USD",
      merchant_name: tx.merchant_name ?? null,
      merchant_category_code: tx.merchant_category_code ?? null,
      sk_category_name: tx.sk_category_name ?? null,
      memo: tx.memo ?? null,
      receipts: tx.receipts ?? [],
      cardholder_ramp_user_id: tx.card_holder?.user_id ?? null,
      cardholder_name: cardholderName,
      cardholder_email: tx.card_holder?.email ?? null,
      card_id: tx.card_id ?? null,
      card_last4: null as string | null,
      asset_id: match.asset_id,
      trailer_id: match.trailer_id,
      asset_link_source: match.source,
      expense_category: expenseCategory,
      match_status: match.status,
      match_confidence: match.confidence,
      match_notes: match.notes,
      matched_at: match.status !== "unmatched" ? new Date().toISOString() : null,
      matched_by: null as string | null,
      raw_payload: tx as unknown,
    },
    match,
  };
}

/**
 * Sync a rolling window of Ramp transactions for one org.
 *
 * `from`/`to` are ISO date strings (YYYY-MM-DD). Overlapping windows are
 * cheap: the unique (org, provider, provider_transaction_id) constraint
 * turns a re-pull into an update-in-place (see the duplicate branch).
 */
export async function syncRamp(
  orgId: string, from: string, to: string,
): Promise<RampSyncResult> {
  const token = await getAccessToken();
  const txns  = await fetchAllTransactions(token, from, to);
  const matchInputs = await loadRampMatchInputs(orgId);

  const result: RampSyncResult = {
    fetched: txns.length, inserted: 0, updated: 0, duplicates: 0,
    failed: 0, autoMatched: 0, notApplicable: 0, failedSample: [],
  };

  for (const tx of txns) {
    const { row, match } = buildRow(orgId, tx, matchInputs);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("ramp_transactions")
      .insert(row);

    if (!error) {
      result.inserted++;
      if (match.status === "auto_matched")   result.autoMatched++;
      if (match.status === "not_applicable") result.notApplicable++;
      continue;
    }

    if ((error as { code?: string }).code === "23505") {
      // Duplicate — refresh mutable fields. Preserve human overrides:
      // if someone hand-assigned an asset (manual_matched or
      // asset_link_source='manual'), don't overwrite the link on re-sync.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await (supabase as any)
        .from("ramp_transactions")
        .select("id, match_status, asset_link_source, expense_category")
        .eq("org_id", orgId)
        .eq("provider", "ramp")
        .eq("provider_transaction_id", tx.id)
        .maybeSingle();
      if (!existing) {
        result.duplicates++;
        continue;
      }
      const preserveMatch =
        existing.match_status === "manual_matched" ||
        existing.asset_link_source === "manual";
      // Category is preserved on re-sync once ANY value is set — the
      // auto-mapper only ever fills in NULLs, so a human choice (via the
      // UI) or an earlier auto-map survives.
      const preserveCategory = existing.expense_category != null;
      const updateRow: Record<string, unknown> = {
        amount: row.amount,
        currency: row.currency,
        merchant_name: row.merchant_name,
        merchant_category_code: row.merchant_category_code,
        sk_category_name: row.sk_category_name,
        memo: row.memo,
        receipts: row.receipts,
        cardholder_ramp_user_id: row.cardholder_ramp_user_id,
        cardholder_name: row.cardholder_name,
        cardholder_email: row.cardholder_email,
        card_id: row.card_id,
        raw_payload: row.raw_payload,
      };
      if (!preserveMatch) {
        updateRow.asset_id          = row.asset_id;
        updateRow.trailer_id        = row.trailer_id;
        updateRow.asset_link_source = row.asset_link_source;
        updateRow.match_status      = row.match_status;
        updateRow.match_confidence  = row.match_confidence;
        updateRow.match_notes       = row.match_notes;
        updateRow.matched_at        = row.matched_at;
      }
      if (!preserveCategory && row.expense_category != null) {
        updateRow.expense_category = row.expense_category;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: uErr } = await (supabase as any)
        .from("ramp_transactions")
        .update(updateRow)
        .eq("id", existing.id);
      if (uErr) {
        result.failed++;
        if (result.failedSample.length < 10) {
          result.failedSample.push({
            providerTransactionId: tx.id,
            error: uErr.message,
          });
        }
      } else {
        result.updated++;
      }
      continue;
    }

    result.failed++;
    if (result.failedSample.length < 10) {
      result.failedSample.push({
        providerTransactionId: tx.id,
        error: error.message,
      });
    }
  }
  return result;
}
