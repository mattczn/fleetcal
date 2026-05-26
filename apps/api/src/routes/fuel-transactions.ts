/**
 * /v1/fuel-transactions — card-side fuel purchases ingested from the
 * carrier's fleet card provider (currently Mudflap). See schema in
 * 20260529_fuel_transactions.sql + FuelTransaction in domain.ts.
 *
 * Endpoints:
 *   POST /inbound-email           — GAS forwards a Mudflap email. API
 *                                   key auth (X-Api-Key), scope
 *                                   'fuel.ingest'. Parses + inserts +
 *                                   auto-matches.
 *   POST /import                  — Bulk pre-parsed import (one-time
 *                                   migration from old my-calendar DB).
 *                                   Clerk auth.
 *   GET  /                        — List with filters. Clerk auth.
 *   PATCH /:id/match              — Manual link / unlink to a driver
 *                                   fuel_report. Clerk auth.
 */

import { Hono } from "hono";
import type {
  FuelTransaction,
  FuelTransactionMatchStatus,
  FuelTransactionProvider,
  InboundFuelEmailRequest,
  InboundFuelEmailResponse,
  BulkImportFuelTransactionsRequest,
  BulkImportFuelTransactionsResponse,
  ListFuelTransactionsResponse,
  MatchFuelTransactionRequest,
  MatchFuelTransactionResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { requireCapability, requireModule } from "../middleware/require.js";

// fuel_transactions isn't in the generated Database types until the
// migrations are applied + types are re-generated. Alias to `any` so
// this file compiles in the meantime — the typed re-import above
// stays available if a specific call site wants type-checked access
// to an already-known table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

// Two sub-routers: one Clerk-authed, one API-key-authed. We mount
// them at different prefixes upstream so the auth middlewares don't
// fight each other on the same path.
const fuelTxClerk  = new Hono<{ Variables: AuthVariables }>();
const fuelTxApiKey = new Hono<{ Variables: AuthVariables }>();

// ── Shared helpers ─────────────────────────────────────────────────────

interface FuelTransactionRow {
  id:                       string;
  org_id:                   string;
  provider:                 string;
  provider_transaction_id:  string;
  transaction_date:         string;
  driver_name:              string | null;
  location:                 string | null;
  matched_truck:            string | null;
  diesel_gallons:           number | null;
  diesel_retail_price:      number | null;
  diesel_discount_price:    number | null;
  diesel_total:             number | null;
  def_gallons:              number | null;
  def_retail_price:         number | null;
  def_discount_price:       number | null;
  def_total:                number | null;
  total_charged:            number;
  total_saved:              number;
  payment_last4:            string | null;
  fuel_report_id:           string | null;
  match_status:             FuelTransactionMatchStatus;
  match_confidence:         number | null;
  match_notes:              string | null;
  matched_at:               string | null;
  matched_by:               string | null;
  legacy_form_response_id:  number | null;
  raw_email:                string | null;
  created_at:               string;
  updated_at:               string | null;
}

const TX_COLS =
  "id,org_id,provider,provider_transaction_id,transaction_date," +
  "driver_name,location,matched_truck," +
  "diesel_gallons,diesel_retail_price,diesel_discount_price,diesel_total," +
  "def_gallons,def_retail_price,def_discount_price,def_total," +
  "total_charged,total_saved,payment_last4," +
  "fuel_report_id,match_status,match_confidence,match_notes," +
  "matched_at,matched_by,legacy_form_response_id,raw_email," +
  "created_at,updated_at";

function rowToTx(r: FuelTransactionRow): FuelTransaction {
  return {
    id:                    r.id,
    orgId:                 r.org_id,
    provider:              r.provider as FuelTransactionProvider,
    providerTransactionId: r.provider_transaction_id,
    transactionDate:       r.transaction_date,
    driverName:            r.driver_name ?? undefined,
    location:              r.location ?? undefined,
    matchedTruck:          r.matched_truck ?? undefined,
    dieselGallons:         r.diesel_gallons ?? undefined,
    dieselRetailPrice:     r.diesel_retail_price ?? undefined,
    dieselDiscountPrice:   r.diesel_discount_price ?? undefined,
    dieselTotal:           r.diesel_total ?? undefined,
    defGallons:            r.def_gallons ?? undefined,
    defRetailPrice:        r.def_retail_price ?? undefined,
    defDiscountPrice:      r.def_discount_price ?? undefined,
    defTotal:              r.def_total ?? undefined,
    totalCharged:          Number(r.total_charged),
    totalSaved:            Number(r.total_saved),
    paymentLast4:          r.payment_last4 ?? undefined,
    fuelReportId:          r.fuel_report_id ?? undefined,
    matchStatus:           r.match_status,
    matchConfidence:       r.match_confidence ?? undefined,
    matchNotes:            r.match_notes ?? undefined,
    matchedAt:             r.matched_at ?? undefined,
    matchedBy:             r.matched_by ?? undefined,
    legacyFormResponseId:  r.legacy_form_response_id ?? undefined,
    createdAt:             r.created_at,
    updatedAt:             r.updated_at ?? undefined,
  };
}

// ── Auto-matcher ───────────────────────────────────────────────────────
//
// Given a freshly-ingested transaction, find the best-matching driver
// fuel_report from the same org and return its id + confidence score.
// Scoring (max 100):
//   • Driver name match (case-insensitive substring): +50
//   • Asset / truck match (matched_truck === driver_report unit): +30
//   • Diesel gallons within ±5%: +15
//   • Date proximity (±24h = full credit, decays linearly to 0 at ±72h): up to +5
//
// Threshold 70+ → auto_matched. Lower → unmatched (dispatch decides).

interface FuelReportCandidate {
  id:              string;
  reported_at:     string;
  driver_id:       number;
  asset_id:        number;
  diesel_gallons:  number;
  driver_name?:    string;    // joined
  asset_unit?:     string;    // joined
}

function scoreMatch(tx: FuelTransactionRow, r: FuelReportCandidate): number {
  let score = 0;

  // Driver name (case-insensitive substring either direction)
  if (tx.driver_name && r.driver_name) {
    const txN = tx.driver_name.toLowerCase();
    const rN  = r.driver_name.toLowerCase();
    if (txN === rN || txN.includes(rN) || rN.includes(txN)) score += 50;
  }

  // Asset / truck unit
  if (tx.matched_truck && r.asset_unit && String(tx.matched_truck).trim() === String(r.asset_unit).trim()) {
    score += 30;
  }

  // Diesel gallons within ±5%
  if (tx.diesel_gallons != null && r.diesel_gallons > 0) {
    const diff = Math.abs(Number(tx.diesel_gallons) - r.diesel_gallons) / r.diesel_gallons;
    if (diff <= 0.05) score += 15;
  }

  // Date proximity — tx.transaction_date is date-only, report has full
  // timestamp. Compare on calendar days; ±0 = 5, ±1 = 3, ±2 = 1, more = 0.
  try {
    const txTime = new Date(tx.transaction_date).getTime();
    const rTime  = new Date(r.reported_at).getTime();
    const diffDays = Math.abs(txTime - rTime) / 86_400_000;
    if (diffDays <= 1) score += 5;
    else if (diffDays <= 2) score += 3;
    else if (diffDays <= 3) score += 1;
  } catch { /* ignore date parse errors */ }

  return score;
}

async function tryAutoMatch(
  orgId: string,
  txRow: FuelTransactionRow,
): Promise<{ fuelReportId: string; confidence: number } | null> {
  // Pull candidate reports within ±3 days of the transaction date and
  // still in 'pending' match status. Limit to a reasonable batch — a
  // small org has a handful per day; even with 100/day a 7-day window
  // is only ~700 rows.
  const from = new Date(txRow.transaction_date);
  from.setDate(from.getDate() - 3);
  const to = new Date(txRow.transaction_date);
  to.setDate(to.getDate() + 3);

  const { data, error } = await supabase
    .from("fuel_reports")
    .select("id, reported_at, driver_id, asset_id, diesel_gallons, drivers!inner(name), assets!inner(unit)")
    .eq("org_id", orgId)
    .eq("match_status", "pending")
    .gte("reported_at", from.toISOString())
    .lte("reported_at", to.toISOString())
    .limit(200);
  if (error) {
    console.warn("[fuel-tx auto-match] candidate fetch failed:", error);
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: FuelReportCandidate[] = (data ?? []).map((r: any) => {
    const row = r;
    return {
      id:             row.id,
      reported_at:    row.reported_at,
      driver_id:      row.driver_id,
      asset_id:       row.asset_id,
      diesel_gallons: Number(row.diesel_gallons),
      driver_name:    row.drivers?.name ?? row.drivers?.[0]?.name,
      asset_unit:     row.assets?.unit  ?? row.assets?.[0]?.unit,
    };
  });

  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const s = scoreMatch(txRow, c);
    if (!best || s > best.score) best = { id: c.id, score: s };
  }
  if (!best || best.score < 70) return null;
  return { fuelReportId: best.id, confidence: best.score };
}

async function applyAutoMatch(
  orgId: string,
  txId: string,
  txRow: FuelTransactionRow,
): Promise<{ status: FuelTransactionMatchStatus; confidence?: number }> {
  const matched = await tryAutoMatch(orgId, txRow);
  if (!matched) return { status: "unmatched" };

  // Two-sided update — flip both ends of the link in a single round
  // trip. If the report-side update fails we don't roll back; the
  // transaction-side link is still correct from the user's perspective.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase
    .from("fuel_transactions")
    .update({
      fuel_report_id:   matched.fuelReportId,
      match_status:     "auto_matched",
      match_confidence: matched.confidence,
      matched_at:       new Date().toISOString(),
    } as any)
    .eq("id", txId)
    .eq("org_id", orgId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase
    .from("fuel_reports")
    .update({
      transaction_id: txId,
      match_status:   "matched",
    } as any)
    .eq("id", matched.fuelReportId)
    .eq("org_id", orgId);

  return { status: "auto_matched", confidence: matched.confidence };
}

// ── POST /v1/fuel-transactions/inbound-email (api-key authed) ─────────

fuelTxApiKey.post("/inbound-email", requireApiKey("fuel.ingest"), async (c) => {
  const orgId = c.get("orgId");
  const body  = await c.req.json<InboundFuelEmailRequest>().catch(() => null);
  if (!body || typeof body.raw !== "string" || body.raw.length === 0) {
    const err: InboundFuelEmailResponse = { ok: false, error: "raw_email_required" };
    return c.json(err, 400);
  }

  // Parse the email. Parser lives in lib/mudflapEmailParser.ts and is
  // currently stubbed — wire returns a soft failure response so the
  // GAS doesn't mark the message read and we retry once we ship the
  // parser.
  const { parseMudflapEmail } = await import("../lib/mudflapEmailParser.js");
  let parsed;
  try {
    parsed = await parseMudflapEmail({ raw: body.raw, pdfB64: body.pdfB64 });
  } catch (err) {
    console.error("[fuel inbound] parse threw:", err);
    const res: InboundFuelEmailResponse = { ok: false, error: `parse_error: ${(err as Error).message}` };
    return c.json(res, 500);
  }
  if (!parsed.ok) {
    const res: InboundFuelEmailResponse = { ok: false, error: parsed.reason };
    return c.json(res, 422);
  }

  // Upsert with ON CONFLICT — duplicate transactionId is a 200 not a 409
  // because re-ingest is the GAS's normal retry path.
  const tx = parsed.transaction;
  const insertRow = {
    org_id:                  orgId,
    provider:                tx.provider,
    provider_transaction_id: tx.providerTransactionId,
    transaction_date:        tx.transactionDate,
    driver_name:             tx.driverName ?? null,
    location:                tx.location ?? null,
    matched_truck:           tx.matchedTruck ?? null,
    diesel_gallons:          tx.dieselGallons ?? null,
    diesel_retail_price:     tx.dieselRetailPrice ?? null,
    diesel_discount_price:   tx.dieselDiscountPrice ?? null,
    diesel_total:            tx.dieselTotal ?? null,
    def_gallons:             tx.defGallons ?? null,
    def_retail_price:        tx.defRetailPrice ?? null,
    def_discount_price:      tx.defDiscountPrice ?? null,
    def_total:               tx.defTotal ?? null,
    total_charged:           tx.totalCharged,
    total_saved:             tx.totalSaved,
    payment_last4:           tx.paymentLast4 ?? null,
    raw_email:               body.raw.length > 200_000 ? body.raw.slice(0, 200_000) : body.raw,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("fuel_transactions")
    .insert(insertRow as any)
    .select(TX_COLS)
    .single();

  if (error) {
    // 23505 = unique violation → already ingested. Return the existing row.
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await supabase
        .from("fuel_transactions")
        .select(TX_COLS)
        .eq("org_id", orgId)
        .eq("provider", tx.provider)
        .eq("provider_transaction_id", tx.providerTransactionId)
        .maybeSingle();
      const res: InboundFuelEmailResponse = {
        ok: true,
        result: "duplicate",
        transactionId: (existing as unknown as FuelTransactionRow | null)?.id,
      };
      return c.json(res, 200);
    }
    console.error("[fuel inbound] insert failed:", error);
    const res: InboundFuelEmailResponse = { ok: false, error: `insert_failed: ${error.message}` };
    return c.json(res, 500);
  }

  const row = data as unknown as FuelTransactionRow;
  const matchResult = await applyAutoMatch(orgId, row.id, row);

  const res: InboundFuelEmailResponse = {
    ok:              true,
    result:          "inserted",
    transactionId:   row.id,
    matchStatus:     matchResult.status,
    matchConfidence: matchResult.confidence,
  };
  return c.json(res, 201);
});

// Shared handler for /import — runs under either Clerk auth or API
// key auth (with scope 'fuel.import'). Bulk historical migration is
// often kicked off from a one-off terminal, where chasing 60s Clerk
// tokens is hostile UX; the api-key path lets a script run cleanly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bulkImportHandler(c: any): Promise<Response> {
  const orgId = c.get("orgId");
  const body  = (await c.req.json().catch(() => null)) as BulkImportFuelTransactionsRequest | null;
  if (!body || !Array.isArray(body.transactions) || body.transactions.length === 0) {
    return c.json({ error: "bad_request", detail: "transactions[] required" } satisfies ApiErrorResponse, 400);
  }
  if (body.transactions.length > 1000) {
    return c.json({ error: "bad_request", detail: "batch limited to 1000 rows" } satisfies ApiErrorResponse, 400);
  }

  let inserted = 0;
  let duplicates = 0;
  const failed: BulkImportFuelTransactionsResponse["failed"] = [];

  // Loop one at a time so a single duplicate doesn't abort the batch.
  // 503 historical rows takes ~5s — well within request timeout.
  for (const t of body.transactions) {
    const insertRow = {
      org_id:                   orgId,
      provider:                 t.provider ?? "mudflap",
      provider_transaction_id:  t.providerTransactionId,
      transaction_date:         t.transactionDate,
      driver_name:              t.driverName ?? null,
      location:                 t.location ?? null,
      matched_truck:            t.matchedTruck ?? null,
      diesel_gallons:           t.dieselGallons ?? null,
      diesel_retail_price:      t.dieselRetailPrice ?? null,
      diesel_discount_price:    t.dieselDiscountPrice ?? null,
      diesel_total:             t.dieselTotal ?? null,
      def_gallons:              t.defGallons ?? null,
      def_retail_price:         t.defRetailPrice ?? null,
      def_discount_price:       t.defDiscountPrice ?? null,
      def_total:                t.defTotal ?? null,
      total_charged:            t.totalCharged,
      total_saved:              t.totalSaved ?? 0,
      payment_last4:            t.paymentLast4 ?? null,
      legacy_form_response_id:  t.legacyFormResponseId ?? null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase.from("fuel_transactions").insert(insertRow as any);
    if (error) {
      if ((error as { code?: string }).code === "23505") { duplicates++; continue; }
      failed.push({ providerTransactionId: t.providerTransactionId, error: error.message });
      continue;
    }
    inserted++;
  }

  const res: BulkImportFuelTransactionsResponse = { inserted, duplicates, failed };
  return c.json(res);
}

// Mount the import handler on the API-key router with scope 'fuel.import'.
// Must be registered BEFORE the clerk path mounts the same route, since
// /v1/fuel-transactions/* requests resolve against the open app router
// first (see index.ts mount order). Same handler, two auth surfaces.
fuelTxApiKey.post("/import", requireApiKey("fuel.import"), bulkImportHandler);

// ── Clerk-authed endpoints below ──────────────────────────────────────

fuelTxClerk.use("*", requireModule("fuel"), requireCapability("fuel.access"));

// POST /v1/fuel-transactions/import — bulk historical import (Clerk path).
// Skips auto-matching (drivers weren't in FleetCal at the time these
// records were created, so there's nothing to match against).
fuelTxClerk.post("/import", bulkImportHandler);

// GET /v1/fuel-transactions — list with filters.
fuelTxClerk.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const matchStatus = url.searchParams.get("matchStatus");
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");
  const q    = url.searchParams.get("q");
  const limit  = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "100"), 1), 500);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0"), 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from("fuel_transactions")
    .select(TX_COLS, { count: "exact" })
    .eq("org_id", orgId)
    .is("deleted_at", null);

  if (matchStatus && matchStatus !== "all") query = query.eq("match_status", matchStatus);
  if (from) query = query.gte("transaction_date", from);
  if (to)   query = query.lte("transaction_date", to);
  if (q && q.trim().length >= 2) {
    const term = q.trim();
    query = query.or(
      `driver_name.ilike.%${term}%,location.ilike.%${term}%,matched_truck.ilike.%${term}%,provider_transaction_id.ilike.%${term}%`,
    );
  }

  const { data, error, count } = await query
    .order("transaction_date", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    console.error("[GET /v1/fuel-transactions]", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = ((data ?? []) as unknown as FuelTransactionRow[]).map(rowToTx);
  const res: ListFuelTransactionsResponse = {
    fuelTransactions: rows,
    total:            count ?? rows.length,
    limit,
    offset,
  };
  return c.json(res);
});

// PATCH /v1/fuel-transactions/:id/match — manual link / unlink.
fuelTxClerk.patch("/:id/match", requireCapability("fuel.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");
  const body   = await c.req.json<MatchFuelTransactionRequest>().catch(() => null);
  if (!body || (body.fuelReportId !== null && typeof body.fuelReportId !== "string")) {
    return c.json({ error: "bad_request", detail: "fuelReportId required (string or null)" } satisfies ApiErrorResponse, 400);
  }

  // Fetch existing row to discover its old fuel_report_id (so we can
  // clear the back-pointer on the formerly-linked report).
  const { data: prev } = await supabase
    .from("fuel_transactions")
    .select("id, fuel_report_id")
    .eq("id", id).eq("org_id", orgId)
    .maybeSingle();
  if (!prev) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const prevReportId = (prev as { fuel_report_id: string | null }).fuel_report_id;

  const updateRow: Record<string, unknown> = body.fuelReportId === null
    ? {
        fuel_report_id:   null,
        match_status:     "unmatched",
        match_confidence: null,
        match_notes:      body.matchNotes ?? null,
        matched_at:       null,
        matched_by:       null,
      }
    : {
        fuel_report_id:   body.fuelReportId,
        match_status:     "manual_matched",
        match_confidence: 100,
        match_notes:      body.matchNotes ?? null,
        matched_at:       new Date().toISOString(),
        matched_by:       userId,
      };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error } = await supabase
    .from("fuel_transactions")
    .update(updateRow as any)
    .eq("id", id).eq("org_id", orgId)
    .select(TX_COLS)
    .single();
  if (error || !updated) {
    return c.json({ error: "update_failed", detail: error?.message ?? "unknown" } satisfies ApiErrorResponse, 500);
  }

  // Sync the fuel_report back-pointers. Clear the old one if it
  // changed; set the new one. Best-effort, doesn't block the response.
  if (prevReportId && prevReportId !== body.fuelReportId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("fuel_reports")
      .update({ transaction_id: null, match_status: "pending" } as any)
      .eq("id", prevReportId).eq("org_id", orgId);
  }
  if (body.fuelReportId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("fuel_reports")
      .update({ transaction_id: id, match_status: "matched" } as any)
      .eq("id", body.fuelReportId).eq("org_id", orgId);
  }

  const res: MatchFuelTransactionResponse = { fuelTransaction: rowToTx(updated as unknown as FuelTransactionRow) };
  return c.json(res);
});

// Two separate routers exported so index.ts can mount the api-key
// branch on the OPEN app group (no clerk wrapper) and the rest under
// `authed`. Combining them here under a single .use("*", clerkAuth)
// would mistakenly apply clerk to /inbound-email — Hono runs the
// wildcard middleware before route resolution, so we can't gate it
// by path from inside.
export { fuelTxApiKey, fuelTxClerk };

// Default export keeps the import shape compatible with other route
// files. Use the named exports above to mount in index.ts.
const fuelTransactions = fuelTxClerk;
export default fuelTransactions;
