/**
 * @fleetcal/types — Shipper CRM
 *
 * The carrier's own shipper / receiver / warehouse outreach surface. This
 * is the carrier prospecting the facilities IT hauls for — distinct from
 * the internal `crm.*` sales tooling (FleetCal selling TO carriers).
 *
 * Facilities are not a stored roster; they are COMPUTED from the stops we
 * already geocode, deduped by location (rounded lat/lng ≈ 111 m bucket =
 * `geoKey`). A visit is counted once per (load, stop-type) so a relay that
 * lists the same stop on every leg doesn't inflate the frequency that
 * drives prioritization. The only stored state is the human outreach layer
 * (status, follow-up, contact, call/email log), kept in `facilities` +
 * `facility_activities` and created lazily the first time someone acts on a
 * facility. A facility with no stored row is implicitly a `prospect`.
 */

// ── Pipeline status ──────────────────────────────────────────────────────

/** Outreach pipeline status. A facility with no stored row = `prospect`. */
export type FacilityStatus =
  | "prospect"        // identified, not contacted yet (the implicit default)
  | "contacted"       // reached out, awaiting a response
  | "in_talks"        // a conversation is going
  | "active"          // actively doing business / won
  | "not_now"         // not now — revisit later
  | "do_not_contact"; // stop

export const FACILITY_STATUSES: readonly FacilityStatus[] = [
  "prospect", "contacted", "in_talks", "active", "not_now", "do_not_contact",
] as const;

export const FACILITY_STATUS_LABEL: Record<FacilityStatus, string> = {
  prospect:       "Prospect",
  contacted:      "Contacted",
  in_talks:       "In talks",
  active:         "Active",
  not_now:        "Not now",
  do_not_contact: "Do not contact",
};

/** Role at a facility, derived from how our stops there break down. */
export type FacilityRole = "shipper" | "receiver" | "both" | "stop";

// ── Call outcomes ──────────────────────────────────────────────────────

export type FacilityCallOutcome =
  | "no_answer" | "voicemail" | "gatekeeper" | "spoke"
  | "interested" | "not_interested" | "callback";

export const FACILITY_CALL_OUTCOMES: readonly FacilityCallOutcome[] = [
  "no_answer", "voicemail", "gatekeeper", "spoke",
  "interested", "not_interested", "callback",
] as const;

export const FACILITY_CALL_OUTCOME_LABEL: Record<FacilityCallOutcome, string> = {
  no_answer:      "No answer",
  voicemail:      "Left voicemail",
  gatekeeper:     "Gatekeeper",
  spoke:          "Spoke with contact",
  interested:     "Interested",
  not_interested: "Not interested",
  callback:       "Call back later",
};

/** Outcomes that move a facility forward when logged, used by the API's
 *  outcome→status mapping. `interested` → in_talks; `not_interested` →
 *  not_now. Everything else just records the attempt. */
export type FacilityActivityKind =
  | "note" | "status_change" | "call" | "email" | "meeting" | "system";

// ── Computed + stored pieces of a facility ─────────────────────────────

/** Lane-history stats for a facility, computed from stops ⨝ events. */
export interface FacilityStats {
  /** Visits = distinct (load, stop-type) touches, deduped across relay legs. */
  visitCount: number;
  /** Visits where we picked up (shipper side). */
  pickupCount: number;
  /** Visits where we delivered (receiver side). */
  deliveryCount: number;
  /** Distinct loads that touched this facility. */
  loadCount: number;
  /** Earliest visit (event start). Naive local 'YYYY-MM-DDTHH:mm' or null. */
  firstSeen: string | null;
  /** Most recent visit. */
  lastSeen: string | null;
}

/** Human outreach state, stored per facility and created lazily. */
export interface FacilityOutreach {
  status: FacilityStatus;
  nextActionAt?: string;
  ownerUserId?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  notes?: string;
  /** User marked it not-a-prospect (own yard, a relay point, etc.). */
  hidden: boolean;
  callAttempts: number;
  lastContactedAt?: string;
  lastCallOutcome?: FacilityCallOutcome;
  updatedAt?: string;
}

/** One facility in the list / on the map — identity + stats + outreach. */
export interface Facility {
  /** Stable identity: rounded "lat,lng" (≈111 m). URL-safe, matches the
   *  server's `fleetcal_geo_key`. */
  geoKey: string;
  /** Most-common non-null facility name across the bucket's stops. */
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  lat: number;
  lng: number;
  role: FacilityRole;
  /** Heuristic: the name looks like our own yard / a relay point, so the
   *  list can default to hiding it from the prospect view. */
  internalGuess: boolean;
  stats: FacilityStats;
  /** Present once someone has acted on it; absent = untouched (prospect). */
  outreach?: FacilityOutreach;
}

export interface FacilityActivity {
  id: string;
  facilityId: string;
  kind: FacilityActivityKind;
  body?: string;
  outcome?: FacilityCallOutcome;
  meta?: Record<string, unknown>;
  actorUserId?: string;
  actorName?: string;
  createdAt: string;
}

/** One load we've run through a facility (deduped by load, newest first). */
export interface FacilityLoad {
  loadId: string;
  internalLoadId?: number;
  loadNum?: string;
  broker?: string;
  loadPrice?: number;
  /** Event start of the (earliest) visit for this load at this facility. */
  visitAt: string | null;
  role: FacilityRole;
}

// ── Wire shapes ────────────────────────────────────────────────────────

/** Snapshot of a facility's identity, sent on the first write so the
 *  server can create the stored row (the rollup isn't recomputed per
 *  write). lat/lng are authoritative; `geoKey` in the URL is the key. */
export interface FacilitySnapshot {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  lat: number;
  lng: number;
}

export interface ListFacilitiesResponse {
  facilities: Facility[];
  summary: {
    facilityCount: number;
    /** Total deduped visits across all facilities (sum of visitCount). A
     *  sum of per-facility loadCount would double-count loads that touch
     *  more than one facility, so the header reports visits instead. */
    visitCount: number;
    pickupFacilities: number;
    deliveryFacilities: number;
  };
}

export interface FacilityDetailResponse {
  facility: Facility;
  loads: FacilityLoad[];
  activities: FacilityActivity[];
}

/** Merge-write the outreach state. Only provided keys change; the snapshot
 *  is used to create the row on first touch. */
export interface UpdateFacilityOutreachRequest {
  snapshot: FacilitySnapshot;
  status?: FacilityStatus;
  nextActionAt?: string | null;
  ownerUserId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  hidden?: boolean;
}

export interface UpdateFacilityOutreachResponse {
  facility: Facility;
}

export interface LogFacilityActivityRequest {
  snapshot: FacilitySnapshot;
  kind: FacilityActivityKind;
  body?: string;
  outcome?: FacilityCallOutcome;
}

export interface LogFacilityActivityResponse {
  activity: FacilityActivity;
  facility: Facility;
}
