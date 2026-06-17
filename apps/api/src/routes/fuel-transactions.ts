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
  AssignFuelTransactionRequest,
  AssignFuelTransactionResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import { applyAutoMatch } from "../lib/fuelMatcher.js";
import { runFuelAutoMatchSweep } from "../jobs/fuelAutoMatchSweep.js";
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
  driver_id:                number | null;
  asset_id:                 number | null;
  asset_link_source:        string | null;
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
  "driver_name,location,matched_truck,driver_id,asset_id,asset_link_source," +
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
    driverId:              r.driver_id ?? undefined,
    assetId:               r.asset_id ?? undefined,
    assetLinkSource:       r.asset_link_source ?? undefined,
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

// ── Ingest-time driver/asset resolution ───────────────────────────────
//
// Try to map the receipt's free-text driver_name → drivers.id and
// matched_truck → assets.id at insert time, so the unified fuel UI
// shows authoritative names instead of receipt strings. Failures are
// non-fatal: the row is still inserted, just without resolved ids;
// the dispatcher picks them via the dropdowns in the detail panel.
async function resolveDriverAndAsset(
  orgId: string,
  driverName: string | null,
  matchedTruck: string | null,
): Promise<{ driverId: number | null; assetId: number | null }> {
  let driverId: number | null = null;
  let assetId:  number | null = null;

  if (driverName && driverName.trim()) {
    // ILIKE substring either direction. Receipts often have a short
    // name ("Kevin") while FleetCal stores the full ("Kevin Smith")
    // — ILIKE %name% covers both directions.
    const { data: dr } = await supabase
      .from("drivers")
      .select("id, name")
      .eq("org_id", orgId)
      .ilike("name", `%${driverName.trim()}%`)
      .limit(2);
    // Only resolve when exactly one driver matches. Multiple hits
    // means the name is ambiguous (two Kevins on the roster) and
    // we'd rather leave it unresolved than guess wrong.
    if (Array.isArray(dr) && dr.length === 1) {
      driverId = (dr[0] as { id: number }).id;
    }
  }

  if (matchedTruck && matchedTruck.trim()) {
    const { data: as } = await supabase
      .from("assets")
      .select("id, unit")
      .eq("org_id", orgId)
      .eq("unit", matchedTruck.trim())
      .limit(2);
    if (Array.isArray(as) && as.length === 1) {
      assetId = (as[0] as { id: number }).id;
    }
  }

  return { driverId, assetId };
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

  // Resolve driver_name → driver_id and matched_truck → asset_id at
  // insert time so the unified fuel UI can show authoritative names
  // even when no driver fuel_report exists to pair with. Failures
  // here are non-fatal — the dropdown in the detail panel lets the
  // dispatcher classify the row manually.
  const tx = parsed.transaction;
  const resolved = await resolveDriverAndAsset(orgId, tx.driverName ?? null, tx.matchedTruck ?? null);

  // Upsert with ON CONFLICT — duplicate transactionId is a 200 not a 409
  // because re-ingest is the GAS's normal retry path.
  const insertRow = {
    org_id:                  orgId,
    provider:                tx.provider,
    provider_transaction_id: tx.providerTransactionId,
    transaction_date:        tx.transactionDate,
    driver_name:             tx.driverName ?? null,
    location:                tx.location ?? null,
    matched_truck:           tx.matchedTruck ?? null,
    driver_id:               resolved.driverId,
    asset_id:                resolved.assetId,
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

// POST /v1/fuel-transactions/mudflap-sync — pull recent transactions
// from the Mudflap Carriers API and ingest them. Body: { from, to } as
// YYYY-MM-DD UTC dates. Returns counts so the UI can render a useful
// toast. The Mudflap token comes from MUDFLAP_CARRIERS_TOKEN env var
// (Curzon-only for now; per-org storage when we onboard a 2nd customer).
fuelTxClerk.post("/mudflap-sync", async (c) => {
  const orgId = c.get("orgId");
  const body  = (await c.req.json().catch(() => null)) as { from?: string; to?: string } | null;
  const from  = body?.from?.trim();
  const to    = body?.to?.trim();
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json({ error: "validation_failed", errors: ["from + to required as YYYY-MM-DD"] } satisfies ApiErrorResponse, 400);
  }
  if (from > to) {
    return c.json({ error: "validation_failed", errors: ["from must be on or before to"] } satisfies ApiErrorResponse, 400);
  }
  try {
    const { syncMudflapCarriers } = await import("../lib/mudflapCarriersSync.js");
    const result = await syncMudflapCarriers(orgId, from, to);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("MUDFLAP_CARRIERS_TOKEN not set")) {
      return c.json({
        error:  "not_configured",
        detail: "Mudflap Carriers API token is not configured for this deployment. Contact support.",
      } satisfies ApiErrorResponse, 503);
    }
    console.error("[POST /v1/fuel-transactions/mudflap-sync] failed:", err);
    return c.json({
      error:  "sync_failed",
      detail: message,
    } satisfies ApiErrorResponse, 500);
  }
});

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
    // Escape PostgREST .or() control chars (% , ( )) before interpolation —
    // an unescaped comma/paren lets the caller inject extra filter terms.
    // Same guard as the loads /search endpoint (loads.ts).
    const term = q.trim().replace(/[%,()]/g, "\\$&");
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
//
// Cross-truck warning (?force=true to override):
//   When the transaction's asset_link_source is 'card' (meaning the
//   asset_id was set deterministically from assets.mudflap_card_last4
//   matching the Mudflap card_last4 on the receipt), linking it to a
//   driver report for a DIFFERENT truck would silently overwrite the
//   card-derived truth. Refuse unless the caller passes ?force=true.
//   The UI shows a confirm dialog with both truck names and re-issues
//   the request with force=true on user confirmation.
fuelTxClerk.patch("/:id/match", requireCapability("fuel.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");
  const force  = c.req.query("force") === "true";
  const body   = await c.req.json<MatchFuelTransactionRequest>().catch(() => null);
  if (!body || (body.fuelReportId !== null && typeof body.fuelReportId !== "string")) {
    return c.json({ error: "bad_request", detail: "fuelReportId required (string or null)" } satisfies ApiErrorResponse, 400);
  }

  // Fetch existing row to discover its old fuel_report_id (so we can
  // clear the back-pointer on the formerly-linked report) AND its
  // current asset_id + asset_link_source for the card-priority check.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: prev } = await (supabase as any)
    .from("fuel_transactions")
    .select("id, fuel_report_id, asset_id, asset_link_source")
    .eq("id", id).eq("org_id", orgId)
    .maybeSingle();
  if (!prev) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const prevRow = prev as { fuel_report_id: string | null; asset_id: number | null; asset_link_source: string | null };
  const prevReportId       = prevRow.fuel_report_id;
  const prevAssetId        = prevRow.asset_id;
  const prevAssetLinkSrc   = prevRow.asset_link_source;

  // When linking to a fuel_report, mirror its driver_id + asset_id
  // onto the transaction so the unified panel's dropdowns reflect
  // the correct values without an extra round-trip — and the unified
  // fuel table can roll up by driver/asset without joining through
  // fuel_reports. Skip the mirror when the caller already has
  // driver_id set on the transaction (don't overwrite an intentional
  // override).
  let mirroredDriverId: number | null = null;
  let mirroredAssetId:  number | null = null;
  if (body.fuelReportId) {
    const { data: linkedReport } = await supabase
      .from("fuel_reports")
      .select("driver_id, asset_id")
      .eq("id", body.fuelReportId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (linkedReport) {
      mirroredDriverId = (linkedReport as { driver_id: number | null }).driver_id ?? null;
      mirroredAssetId  = (linkedReport as { asset_id:  number | null }).asset_id  ?? null;
    }
  }

  // Card-priority guard: if the current asset_id was set by the
  // Mudflap card matcher (asset_link_source='card'), refuse to
  // overwrite with a report that points at a different truck — that's
  // almost certainly a dispatcher mistake. Pass ?force=true to override.
  if (
    !force
    && body.fuelReportId
    && prevAssetLinkSrc === "card"
    && prevAssetId != null
    && mirroredAssetId != null
    && mirroredAssetId !== prevAssetId
  ) {
    // Look up both truck display names so the UI dialog can show
    // "CT-2021" vs "CT-2027" instead of raw IDs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: assets } = await (supabase as any)
      .from("assets")
      .select("id, name, unit, mudflap_card_last4")
      .in("id", [prevAssetId, mirroredAssetId])
      .eq("org_id", orgId);
    const byId = new Map<number, { name: string; unit: string | null; mudflap_card_last4: string | null }>();
    for (const a of (assets ?? []) as Array<{ id: number; name: string; unit: string | null; mudflap_card_last4: string | null }>) {
      byId.set(a.id, { name: a.name, unit: a.unit, mudflap_card_last4: a.mudflap_card_last4 });
    }
    const cardAsset   = byId.get(prevAssetId);
    const reportAsset = byId.get(mirroredAssetId);
    // Body is a structured error — additional fields beyond the
    // standard ApiErrorResponse shape so the UI can render the dialog
    // with both truck names. Cast through unknown to skip the
    // satisfies-narrowing on this one endpoint.
    return c.json({
      error:           "card_truck_mismatch",
      detail:          `This transaction is for ${cardAsset?.name ?? `truck #${prevAssetId}`} (Mudflap card ****${cardAsset?.mudflap_card_last4 ?? "????"}), but you're linking it to a report for ${reportAsset?.name ?? `truck #${mirroredAssetId}`}. Pass force=true to override.`,
      cardAssetId:     prevAssetId,
      cardAssetName:   cardAsset?.name ?? null,
      cardAssetUnit:   cardAsset?.unit ?? null,
      cardLast4:       cardAsset?.mudflap_card_last4 ?? null,
      reportAssetId:   mirroredAssetId,
      reportAssetName: reportAsset?.name ?? null,
      reportAssetUnit: reportAsset?.unit ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, 409);
  }

  const updateRow: Record<string, unknown> = body.fuelReportId === null
    ? {
        fuel_report_id:   null,
        match_status:     "unmatched",
        match_confidence: null,
        match_notes:      body.matchNotes ?? null,
        matched_at:       null,
        matched_by:       null,
        // Unlinking does NOT clear driver_id/asset_id — those may
        // have been set independently via /assign and should survive
        // an unlink so the dispatcher's attribution work isn't lost.
      }
    : {
        fuel_report_id:    body.fuelReportId,
        match_status:      "manual_matched",
        match_confidence:  100,
        match_notes:       body.matchNotes ?? null,
        matched_at:        new Date().toISOString(),
        matched_by:        userId,
        // Pre-populate driver/asset from the linked report; the
        // override block below preserves any prior intentional value.
        driver_id:         mirroredDriverId,
        asset_id:          mirroredAssetId,
        asset_link_source: mirroredAssetId != null ? "report" : null,
      };

  // Preserve prior driver/asset attribution. Three cases:
  //   - prev had no asset_id          → use mirroredAssetId, src=report
  //   - prev had asset_id, same truck → keep both id + src
  //   - prev had asset_id, force=true override on cross-truck → adopt
  //     the report's truck and mark src='manual' (dispatcher chose)
  // The cross-truck-without-force case is already blocked above (409).
  if (body.fuelReportId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prevFull } = await (supabase as any)
      .from("fuel_transactions")
      .select("driver_id")
      .eq("id", id).eq("org_id", orgId)
      .maybeSingle();
    const prevDriver = (prevFull as { driver_id: number | null } | null)?.driver_id ?? null;
    if (prevDriver != null) updateRow.driver_id = prevDriver;

    if (prevAssetId != null) {
      if (force && mirroredAssetId != null && mirroredAssetId !== prevAssetId) {
        updateRow.asset_id          = mirroredAssetId;
        updateRow.asset_link_source = "manual";
      } else {
        updateRow.asset_id          = prevAssetId;
        updateRow.asset_link_source = prevAssetLinkSrc;
      }
    }
  }

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

// POST /v1/fuel-transactions/:id/auto-match — single-row matcher.
//
// Same logic as the 15-min sweep and the on-ingest matcher, but
// scoped to one transaction. Lets the detail panel give the user
// focused feedback ("matched to driver X's report" vs "no match
// found within ±3 days") instead of relying on the global sweep
// which only returns aggregate counts.
fuelTxClerk.post("/:id/auto-match", requireCapability("fuel.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  // Pull the row first — the matcher needs its date / driver_name /
  // matched_truck / diesel_gallons.
  const { data: row, error: fetchErr } = await supabase
    .from("fuel_transactions")
    .select(TX_COLS)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (fetchErr || !row) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const txRow = row as unknown as FuelTransactionRow;
  if (txRow.match_status !== "unmatched") {
    // Already matched (auto, manual, or no_match_needed). Echo the
    // row back without re-running the matcher — clobbering an existing
    // manual link from a curious dispatcher click is hostile UX.
    return c.json({
      result:          "already_matched",
      fuelTransaction: rowToTx(txRow),
    });
  }

  const result = await applyAutoMatch(orgId, id, txRow);

  // Re-fetch to return the updated row.
  const { data: updated } = await supabase
    .from("fuel_transactions")
    .select(TX_COLS)
    .eq("org_id", orgId)
    .eq("id", id)
    .single();

  return c.json({
    result:          result.status,
    confidence:      result.confidence,
    fuelTransaction: updated ? rowToTx(updated as unknown as FuelTransactionRow) : rowToTx(txRow),
  });
});

// PATCH /v1/fuel-transactions/:id/assign — set driver_id + asset_id
// directly on a card transaction, independent of any driver
// fuel_report. Used when the dispatcher classifies a card_only
// row via the dropdowns in the detail panel.
//
// When body.applyToSimilar=true, the server also updates every
// OTHER fuel_transaction in the same org that:
//   • has the same driver_name (case-insensitive trim match)
//   • doesn't already have a driver_id set
//   • isn't deleted
//
// Useful for backfilling — "all of Kevin's transactions are Kevin
// on truck X" — in a single click instead of clicking through each
// row. Doesn't touch already-classified rows so a previous one-off
// override (e.g. a Kevin who happened to drive a different truck
// that day) isn't blown away.
fuelTxClerk.patch("/:id/assign", requireCapability("fuel.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const body  = await c.req.json<AssignFuelTransactionRequest>().catch(() => null);
  if (!body || (body.driverId !== null && !Number.isFinite(body.driverId))
            || (body.assetId  !== null && !Number.isFinite(body.assetId))) {
    return c.json({ error: "bad_request", detail: "driverId and assetId required (number or null)" } satisfies ApiErrorResponse, 400);
  }

  // Validate driver/asset belong to this org. Skip when null
  // (caller is clearing the assignment).
  if (body.driverId != null) {
    const { data: d } = await supabase
      .from("drivers")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", body.driverId)
      .maybeSingle();
    if (!d) return c.json({ error: "bad_request", detail: "driverId not in this org" } satisfies ApiErrorResponse, 400);
  }
  if (body.assetId != null) {
    const { data: a } = await supabase
      .from("assets")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", body.assetId)
      .maybeSingle();
    if (!a) return c.json({ error: "bad_request", detail: "assetId not in this org" } satisfies ApiErrorResponse, 400);
  }

  // Fetch the original row first so we know its driver_name for the
  // applyToSimilar lookup. Also confirms it exists and belongs to
  // this org.
  const { data: orig } = await supabase
    .from("fuel_transactions")
    .select("id, driver_name")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!orig) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const origDriverName = (orig as { driver_name: string | null }).driver_name;

  // Primary update. asset_link_source = 'manual' when the dispatcher
  // explicitly sets an asset_id; cleared to null when assetId is null.
  const { data: updated, error } = await supabase
    .from("fuel_transactions")
    .update({
      driver_id:         body.driverId,
      asset_id:          body.assetId,
      asset_link_source: body.assetId != null ? "manual" : null,
    } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    .eq("id", id).eq("org_id", orgId)
    .select(TX_COLS)
    .single();
  if (error || !updated) {
    return c.json({ error: "update_failed", detail: error?.message ?? "unknown" } satisfies ApiErrorResponse, 500);
  }

  // Bulk-apply path. Match by lower-cased trimmed driver_name. Only
  // touches rows that don't already have a driver_id (so we don't
  // overwrite earlier intentional overrides).
  let alsoUpdated = 0;
  if (body.applyToSimilar && origDriverName && origDriverName.trim()) {
    const normalized = origDriverName.trim();
    const { data: similar, error: simErr } = await supabase
      .from("fuel_transactions")
      .update({
        driver_id:         body.driverId,
        asset_id:          body.assetId,
        asset_link_source: body.assetId != null ? "manual" : null,
      } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .eq("org_id", orgId)
      .ilike("driver_name", normalized)   // case-insensitive exact match
      .is("driver_id", null)
      .is("deleted_at", null)
      .neq("id", id)
      .select("id");
    if (simErr) {
      // Bulk path errored after the primary update succeeded.
      // Return the primary update but log + flag the partial.
      console.warn("[fuel assign] applyToSimilar bulk update failed:", simErr);
    } else {
      alsoUpdated = Array.isArray(similar) ? similar.length : 0;
    }
  }

  const res: AssignFuelTransactionResponse = {
    fuelTransaction: rowToTx(updated as unknown as FuelTransactionRow),
    alsoUpdated:     body.applyToSimilar ? alsoUpdated : undefined,
  };
  return c.json(res);
});

// POST /v1/fuel-transactions/auto-match-sweep — on-demand sweep.
//
// Same job that runs every 15 min from index.ts, but a dispatcher
// can fire it manually before reviewing the fuel table — useful
// after bulk-editing assets or right after a known late driver-
// report-arrival batch.
//
// Limited to org-scope (the underlying sweep is cross-org, but this
// endpoint filters the result down so a normal dispatcher only sees
// their own org's numbers). Auth: fuel.edit capability.
fuelTxClerk.post("/auto-match-sweep", requireCapability("fuel.edit"), async (c) => {
  const orgId = c.get("orgId");
  try {
    const result = await runFuelAutoMatchSweep();
    const own = result.byOrg[orgId] ?? { scanned: 0, matched: 0 };
    return c.json({
      scanned: own.scanned,
      matched: own.matched,
    });
  } catch (err) {
    console.error("[fuel auto-match sweep] manual trigger failed:", err);
    return c.json({ error: "sweep_failed", detail: (err as Error).message } satisfies ApiErrorResponse, 500);
  }
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
