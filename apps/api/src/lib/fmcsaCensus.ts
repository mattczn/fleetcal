/**
 * FMCSA Company Census File lead source (Socrata SODA API).
 *
 * Dataset: data.transportation.gov az4n-8mr2 — the public MCMIS census
 * extract, refreshed daily. No auth required; an optional Socrata app
 * token (FMCSA_SODA_APP_TOKEN) raises the throttling ceiling.
 *
 * Field facts verified live (2026-07-02):
 *   - Nearly every column is TEXT in Socrata, including dot_number
 *     ("9999984") and power_units ("10"). Numeric comparisons must go
 *     through SoQL's `::number` cast — critical because DOT numbers
 *     are about to roll from 7 to 8 digits, where lexicographic
 *     ordering breaks ('10000001' < '9999984').
 *   - add_date is "YYYYMMDD" text (8 chars).
 *   - mcs150_date is "YYYYMMDD HHMM" text (13 chars). Both compare
 *     correctly as strings when the compared value is same-length.
 *   - The *_within/beyond_100_miles fields are DRIVER COUNTS, not Y/N.
 *   - carship is semicolon-joined multi-value ("C", "C;S", "B", …).
 *     C = carrier. Server-side LIKE '%C%' is safe (no other token
 *     contains the letter C); we still re-check precisely client-side.
 *
 * TARGET: ESTABLISHED CARRIERS.
 * We don't target brand-new registrations (paperwork-only, no revenue,
 * don't buy software). We target established for-hire fleets running
 * 4–10 trucks that have outgrown spreadsheets: registered 1–15 years
 * ago, still filing MCS-150s (proves actively operating). The census
 * has ~28,700 such carriers nationally at default ICP.
 *
 * Sync strategy: forward walk on dot_number from 0, pushing date +
 * fleet-size filters server-side so pages return only qualifying
 * rows. Cursor persists after every page so a mid-run crash resumes
 * cleanly. Once cursor >= max-matching-DOT the walk is done —
 * subsequent runs mostly no-op (an occasional match reappears when an
 * old carrier files a fresh MCS-150). The (org_id, dot_number) unique
 * index absorbs re-seen rows as duplicates on any overlap.
 */

import { env } from "./env.js";
import type { CrmIcpFilters } from "@fleetcal/types";
import type {
  CarrierLeadRecord,
  FetchNewCarriersResult,
  LeadSource,
  LeadSourceCursor,
} from "./leadSource.js";

const BASE_URL = "https://data.transportation.gov/resource/az4n-8mr2.json";
const PAGE_SIZE = 1000;
/** Pause between pages — polite pacing well under Socrata's anonymous
 *  throttle; with an app token this is still fine at 30 pages/run. */
const INTER_PAGE_MS = 1100;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;
const MAX_RETRIES = 3;

const SELECT_FIELDS = [
  "dot_number", "legal_name", "dba_name", "email_address", "phone", "cell_phone",
  "phy_street", "phy_city", "phy_state", "phy_zip",
  "power_units", "total_drivers", "carrier_operation", "carship", "classdef", "hm_ind",
  "mcs150_date", "add_date", "status_code",
  "interstate_within_100_miles", "interstate_beyond_100_miles",
  "intrastate_within_100_miles", "intrastate_beyond_100_miles",
].join(",");

type CensusRow = Record<string, string | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toInt(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** "YYYYMMDD" → "YYYY-MM-DD" (census date format), else undefined. */
function toIsoDate(v: string | undefined): string | undefined {
  if (!v || !/^\d{8}/.test(v)) return undefined;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/** Date `N` years ago as census YYYYMMDD text. */
function yearsAgoYmd(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function monthsAgoYmd(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Build the SODA WHERE clause from the ICP settings. Filters that can
 *  run server-side (dates, numeric power units, active + carrier + states)
 *  land here; for-hire and radius proxies stay client-side. */
function buildWhere(icp: CrmIcpFilters, afterDot: number): string {
  const parts: string[] = [
    `dot_number::number > ${afterDot}`,
    `status_code='A'`,
    `carship like '%C%'`,
    `power_units::number >= ${icp.powerUnitsMin}`,
    `power_units::number <= ${icp.powerUnitsMax}`,
  ];
  const minAge = icp.establishedYearsMin ?? 1;
  const maxAge = icp.establishedYearsMax ?? 15;
  // Established at least N years ago = add_date <= (today - N years).
  parts.push(`add_date <= '${yearsAgoYmd(minAge)}'`);
  parts.push(`add_date >= '${yearsAgoYmd(maxAge)}'`);
  const mcs150Months = icp.mcs150SinceMonths ?? 24;
  // mcs150_date is 13-char "YYYYMMDD HHMM"; compare to 8-char boundary
  // — SoQL string compare works because the boundary is shorter and
  // matches the date prefix.
  parts.push(`mcs150_date >= '${monthsAgoYmd(mcs150Months)}'`);
  if (icp.states.length > 0) {
    const quoted = icp.states.map((s) => `'${s.replace(/'/g, "")}'`).join(",");
    parts.push(`phy_state in(${quoted})`);
  }
  return parts.join(" AND ");
}

/** Fetch one SODA page with exponential backoff on 429/5xx. */
async function fetchPage(icp: CrmIcpFilters, afterDot: number): Promise<CensusRow[]> {
  const params = new URLSearchParams({
    $select: SELECT_FIELDS,
    $where: buildWhere(icp, afterDot),
    $order: "dot_number::number ASC",
    $limit: String(PAGE_SIZE),
  });
  const headers: Record<string, string> = {};
  if (env.fmcsaSodaAppToken) headers["X-App-Token"] = env.fmcsaSodaAppToken;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
      await sleep(wait);
    }
    try {
      const res = await fetch(`${BASE_URL}?${params}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`SODA ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`SODA request failed: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
      return (await res.json()) as CensusRow[];
    } catch (err) {
      // AbortError / network blips retry like 5xx; anything thrown
      // above (4xx) propagates immediately.
      if (err instanceof Error && err.message.startsWith("SODA request failed")) throw err;
      lastErr = err;
    }
  }
  throw new Error(`FMCSA SODA fetch failed after ${MAX_RETRIES + 1} attempts: ${String(lastErr)}`);
}

/** Precise carrier check on the multi-value carship field ("C;S" → true). */
function isCarrier(row: CensusRow): boolean {
  return (row.carship ?? "").split(";").includes("C");
}

/** Local-loads proxy: some drivers within 100 miles, none beyond. */
function passesLocalProxy(r: CarrierLeadRecord): boolean {
  const within = (r.interstateWithin100 ?? 0) + (r.intrastateWithin100 ?? 0);
  const beyond = (r.interstateBeyond100 ?? 0) + (r.intrastateBeyond100 ?? 0);
  return within > 0 && beyond === 0;
}

function mapRow(row: CensusRow): CarrierLeadRecord | null {
  const dot = toInt(row.dot_number);
  const legalName = row.legal_name?.trim();
  if (!dot || !legalName) return null;
  return {
    dotNumber: dot,
    legalName,
    dbaName:    row.dba_name?.trim() || undefined,
    email:      row.email_address?.trim().toLowerCase() || undefined,
    phone:      row.phone?.trim() || undefined,
    cellPhone:  row.cell_phone?.trim() || undefined,
    phyStreet:  row.phy_street?.trim() || undefined,
    phyCity:    row.phy_city?.trim() || undefined,
    phyState:   row.phy_state?.trim() || undefined,
    phyZip:     row.phy_zip?.trim() || undefined,
    powerUnits:   toInt(row.power_units),
    totalDrivers: toInt(row.total_drivers),
    carrierOperation: row.carrier_operation || undefined,
    interstateWithin100: toInt(row.interstate_within_100_miles),
    interstateBeyond100: toInt(row.interstate_beyond_100_miles),
    intrastateWithin100: toInt(row.intrastate_within_100_miles),
    intrastateBeyond100: toInt(row.intrastate_beyond_100_miles),
    hmInd:        row.hm_ind === "Y",
    mcs150Date:   toIsoDate(row.mcs150_date),
    fmcsaAddDate: toIsoDate(row.add_date),
    raw: row as Record<string, unknown>,
  };
}

/** Client-side ICP filter (for-hire + operation class + local proxy).
 *  All numeric/date filters run server-side in buildWhere(). */
function icpVerdict(r: CarrierLeadRecord, icp: CrmIcpFilters): "pass" | "fail" | "local_fail" {
  // For-hire gate (default on): census classdef is semicolon-joined
  // (e.g. "PRIVATE PROPERTY;AUTHORIZED FOR HIRE"); any for-hire class
  // qualifies. Private-only fleets don't buy dispatch software.
  if (icp.forHireOnly !== false) {
    const classdef = String(r.raw.classdef ?? "");
    if (!classdef.includes("AUTHORIZED FOR HIRE")) return "fail";
  }
  if (icp.operationClasses.length > 0 &&
      (!r.carrierOperation || !icp.operationClasses.includes(r.carrierOperation as "A" | "B" | "C"))) {
    return "fail";
  }
  if (icp.localOnly && !passesLocalProxy(r)) return "local_fail";
  return "pass";
}

/** Probe the dataset's current max DOT number — kept for the internal
 *  reset endpoint (rewind cursor to 0 → this replaces the old
 *  "seed at frontier" behavior). */
export async function probeMaxDotNumber(): Promise<number> {
  const params = new URLSearchParams({
    $select: "dot_number",
    $order: "dot_number::number DESC",
    $limit: "1",
  });
  const headers: Record<string, string> = {};
  if (env.fmcsaSodaAppToken) headers["X-App-Token"] = env.fmcsaSodaAppToken;
  const res = await fetch(`${BASE_URL}?${params}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`FMCSA max-DOT probe failed: ${res.status}`);
  const rows = (await res.json()) as CensusRow[];
  const max = toInt(rows[0]?.dot_number);
  if (!max) throw new Error("FMCSA max-DOT probe returned no rows");
  return max;
}

export const fmcsaCensusSource: LeadSource = {
  slug: "fmcsa_census",

  async fetchNewCarriers(
    icp: CrmIcpFilters,
    cursor: LeadSourceCursor,
    opts: { maxPages: number },
  ): Promise<FetchNewCarriersResult> {
    // Forward walk on dot_number: cursor is the highest DOT we've
    // fully processed. Starts at 0 for a fresh walk (initial backfill
    // covers the ~28k matching carriers over a few sync ticks).
    let afterDot = cursor.lastDotNumber ?? 0;
    const records: CarrierLeadRecord[] = [];
    let fetched = 0;
    let exhausted = false;

    for (let page = 0; page < opts.maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_MS);
      const rows = await fetchPage(icp, afterDot);
      fetched += rows.length;
      for (const row of rows) {
        const mapped = mapRow(row);
        if (!mapped || !isCarrier(row)) continue;
        const verdict = icpVerdict(mapped, icp);
        if (verdict === "fail") continue;
        if (verdict === "local_fail") mapped.failsLocalProxy = true;
        records.push(mapped);
      }
      // Advance cursor to the last row of the page even when every row
      // filtered out client-side, so a client-filter-heavy stretch
      // (e.g. lots of private fleets) doesn't stall the walk.
      const lastDot = toInt(rows[rows.length - 1]?.dot_number);
      if (lastDot) afterDot = lastDot;
      if (rows.length < PAGE_SIZE) { exhausted = true; break; }
    }

    return { records, nextCursor: { lastDotNumber: afterDot }, exhausted, fetched };
  },
};
