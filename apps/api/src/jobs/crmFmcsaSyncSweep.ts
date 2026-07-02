/**
 * Periodic FMCSA census → crm_leads ingest (INTERNAL sales CRM).
 *
 * For each org in CRM_INTERNAL_ORG_IDS: read the org's ICP filters
 * (org_settings.crm_settings) + keyset cursor (crm_sync_state), pull
 * new carriers from the census source, and insert them as leads.
 *
 * Idempotent: inserts use ignoreDuplicates against the partial-unique
 * (org_id, dot_number) index — a re-seen DOT is counted as a duplicate,
 * never an error, and NEVER updates the existing row (a census re-pull
 * must not clobber human edits or pipeline status).
 *
 * Cursor: persisted to crm_sync_state after every page batch, so a
 * mid-run crash resumes where it left off. First run per org seeds the
 * cursor at the dataset's current max DOT (settings can override with
 * syncStartDotNumber to backfill recent registrants).
 *
 * No-ops cleanly when CRM_INTERNAL_ORG_IDS is unset (customer-facing
 * deploys without the CRM). Scheduled on a 6-hour interval in
 * apps/api/src/index.ts (dataset refreshes daily; the manual "Sync
 * now" button covers impatience).
 */

import { env } from "../lib/env.js";
import { supabase } from "../lib/supabase.js";
import { fmcsaCensusSource, probeMaxDotNumber } from "../lib/fmcsaCensus.js";
import type { CarrierLeadRecord, LeadSourceCursor } from "../lib/leadSource.js";
import { resolveCrmSettings, type CrmSyncResult, type Database, type Json } from "@fleetcal/types";

type CrmLeadInsert = Database["public"]["Tables"]["crm_leads"]["Insert"];

const DEFAULT_MAX_PAGES = Number(process.env.CRM_FMCSA_SYNC_MAX_PAGES ?? 10);

export interface CrmSyncSweepResult {
  skipped: boolean;
  reason?: string;
  orgs?: Array<{ orgId: string; result?: CrmSyncResult; error?: string }>;
}

function leadInsertRow(orgId: string, r: CarrierLeadRecord): CrmLeadInsert {
  return {
    org_id:            orgId,
    dot_number:        r.dotNumber,
    source:            "fmcsa_census",
    legal_name:        r.legalName,
    dba_name:          r.dbaName ?? null,
    email:             r.email ?? null,
    phone:             r.phone ?? null,
    cell_phone:        r.cellPhone ?? null,
    phy_street:        r.phyStreet ?? null,
    phy_city:          r.phyCity ?? null,
    phy_state:         r.phyState ?? null,
    phy_zip:           r.phyZip ?? null,
    power_units:       r.powerUnits ?? null,
    total_drivers:     r.totalDrivers ?? null,
    carrier_operation: r.carrierOperation ?? null,
    interstate_within_100: r.interstateWithin100 ?? null,
    interstate_beyond_100: r.interstateBeyond100 ?? null,
    intrastate_within_100: r.intrastateWithin100 ?? null,
    intrastate_beyond_100: r.intrastateBeyond100 ?? null,
    hm_ind:            r.hmInd ?? null,
    mcs150_date:       r.mcs150Date ?? null,
    fmcsa_add_date:    r.fmcsaAddDate ?? null,
    raw:               r.raw as Json,
    // Soft local-proxy failure → auto-disqualified (still ingested).
    // Email present → enriched (sequence-eligible); missing → new.
    status: r.failsLocalProxy ? "disqualified" : (r.email ? "enriched" : "new"),
  };
}

/** Run one org's sync. Exported for the manual trigger endpoints. */
export async function syncCrmLeadsForOrg(
  orgId: string,
  opts: { maxPages?: number; resetCursorToDot?: number } = {},
): Promise<CrmSyncResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const source = fmcsaCensusSource;

  // Settings + cursor
  const { data: settingsRow } = await supabase
    .from("org_settings")
    .select("crm_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  const settings = resolveCrmSettings(
    (settingsRow as { crm_settings?: unknown } | null)?.crm_settings,
  );

  const { data: stateRow } = await supabase
    .from("crm_sync_state")
    .select("cursor")
    .eq("org_id", orgId)
    .eq("source", source.slug)
    .maybeSingle();
  let cursor: LeadSourceCursor =
    ((stateRow as { cursor?: LeadSourceCursor } | null)?.cursor) ?? {};

  if (opts.resetCursorToDot != null) {
    cursor = { lastDotNumber: opts.resetCursorToDot };
  } else if (cursor.lastDotNumber == null) {
    // First run: seed at settings override or the dataset's current max
    // so we ingest only carriers registered from go-live onward.
    cursor = {
      lastDotNumber: settings.syncStartDotNumber ?? (await probeMaxDotNumber()),
    };
  }

  const persistCursor = async (c: LeadSourceCursor, lastError: string | null) => {
    await supabase.from("crm_sync_state").upsert(
      {
        org_id: orgId,
        source: source.slug,
        cursor: c as unknown as Json,
        last_run_at: new Date().toISOString(),
        last_error: lastError,
      },
      { onConflict: "org_id,source" },
    );
  };

  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  let disqualified = 0;

  try {
    const res = await source.fetchNewCarriers(settings.icp, cursor, { maxPages });
    fetched = res.fetched;
    cursor = res.nextCursor;

    if (res.records.length > 0) {
      disqualified = res.records.filter((r) => r.failsLocalProxy).length;
      // Postgres won't accept our PARTIAL unique index (idx_crm_leads_org_dot
      // WHERE dot_number IS NOT NULL) as an ON CONFLICT target — the
      // constraint-lookup for `upsert(..., onConflict:'org_id,dot_number')`
      // fails ("no unique or exclusion constraint matching..."). So we
      // pre-filter existing DOTs for this org and insert only the new
      // rows. Idempotent enough at 6h cadence + single-replica cron;
      // any last-second race still hits the partial index and errors,
      // which we catch below and count as a duplicate.
      const dots = res.records.map((r) => r.dotNumber);
      const { data: existing } = await supabase
        .from("crm_leads")
        .select("dot_number")
        .eq("org_id", orgId)
        .in("dot_number", dots);
      const existingSet = new Set(
        ((existing ?? []) as Array<{ dot_number: number }>).map((r) => Number(r.dot_number)),
      );
      const fresh = res.records.filter((r) => !existingSet.has(r.dotNumber));
      duplicates = res.records.length - fresh.length;

      if (fresh.length > 0) {
        const rows = fresh.map((r) => leadInsertRow(orgId, r));
        const { data: insertedRows, error } = await supabase
          .from("crm_leads")
          .insert(rows)
          .select("id");
        if (error) {
          // Last-second race with another writer: fall back to per-row
          // inserts, treating 23505 as a duplicate.
          if (error.code === "23505") {
            let ok = 0;
            for (const row of rows) {
              const { error: e2 } = await supabase.from("crm_leads").insert(row).select("id").single();
              if (!e2) ok++;
              else if (e2.code === "23505") duplicates++;
              else throw new Error(`crm_leads insert failed: ${e2.message}`);
            }
            inserted = ok;
          } else {
            throw new Error(`crm_leads insert failed: ${error.message}`);
          }
        } else {
          inserted = insertedRows?.length ?? 0;
        }
      }
    }

    await persistCursor(cursor, null);
  } catch (err) {
    // Persist whatever progress we made before surfacing the failure.
    await persistCursor(cursor, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { fetched, inserted, duplicates, disqualified, cursorDotNumber: cursor.lastDotNumber };
}

export async function runCrmFmcsaSyncSweep(): Promise<CrmSyncSweepResult> {
  // Customer-facing deploys without the CRM: no-op cleanly instead of
  // erroring every interval (mirrors runMudflapSyncSweep's no_token).
  if (env.crmInternalOrgIds.length === 0) {
    return { skipped: true, reason: "no_internal_orgs" };
  }

  const orgs: CrmSyncSweepResult["orgs"] = [];
  for (const orgId of env.crmInternalOrgIds) {
    try {
      const result = await syncCrmLeadsForOrg(orgId);
      orgs.push({ orgId, result });
    } catch (err) {
      // One org's failure must not starve the others.
      console.error(`[crm-fmcsa-sync] org ${orgId} failed:`, err);
      orgs.push({ orgId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { skipped: false, orgs };
}
