/**
 * Lead-source abstraction for the CRM's carrier ingest.
 *
 * FMCSA is migrating its registration system to MOTUS during 2026 and
 * the shape/home of the public census data may change with it. This
 * interface isolates "where carrier records come from" from the sync
 * job and the DB upsert, so swapping fmcsaCensus.ts for a MOTUS
 * implementation is a one-file change: crm_sync_state keys cursors by
 * `source` slug, and crm_leads.raw keeps the source row verbatim.
 */

import type { CrmIcpFilters } from "@fleetcal/types";

/** A carrier record normalized from the source into crm_leads shape. */
export interface CarrierLeadRecord {
  dotNumber: number;
  legalName: string;
  dbaName?: string;
  email?: string;
  phone?: string;
  cellPhone?: string;
  phyStreet?: string;
  phyCity?: string;
  phyState?: string;
  phyZip?: string;
  powerUnits?: number;
  totalDrivers?: number;
  carrierOperation?: string;
  interstateWithin100?: number;
  interstateBeyond100?: number;
  intrastateWithin100?: number;
  intrastateBeyond100?: number;
  hmInd?: boolean;
  mcs150Date?: string;   // ISO date
  fmcsaAddDate?: string; // ISO date
  /** Full source row, stored verbatim in crm_leads.raw. */
  raw: Record<string, unknown>;
  /** True when the record fails the soft "local carrier" proxy while
   *  the org's ICP has localOnly on — ingested but auto-disqualified. */
  failsLocalProxy?: boolean;
}

/** Opaque-ish cursor persisted in crm_sync_state.cursor. */
export interface LeadSourceCursor {
  /** Keyset cursor: highest DOT number already ingested. */
  lastDotNumber?: number;
}

export interface FetchNewCarriersResult {
  records: CarrierLeadRecord[];
  nextCursor: LeadSourceCursor;
  /** True when the source has no more rows past nextCursor (caught up). */
  exhausted: boolean;
  /** Rows fetched from the source before ICP filtering (for metrics). */
  fetched: number;
}

export interface LeadSource {
  /** Slug stored in crm_sync_state.source and crm_leads.source. */
  readonly slug: string;
  fetchNewCarriers(
    icp: CrmIcpFilters,
    cursor: LeadSourceCursor,
    opts: { maxPages: number },
  ): Promise<FetchNewCarriersResult>;
}
