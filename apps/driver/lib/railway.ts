/**
 * Driver-app HTTP client for the Railway API. Pulls the Supabase access
 * token off the current session for every request and sends it as a
 * Bearer header — the API's `driverAuth` middleware verifies it and
 * resolves to the driver's row.
 *
 * All endpoints under /v1/driver/* are scoped to that one driver, so the
 * client doesn't need to send orgId / driverId — they come from the JWT
 * claims server-side.
 */
import { supabase } from "@/lib/supabase";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

class ApiError extends Error {
  constructor(public status: number, public detail?: unknown) {
    const tail = typeof detail === "string"
      ? detail
      : detail
        ? JSON.stringify(detail)
        : "";
    super(`api ${status}${tail ? ` — ${tail.slice(0, 300)}` : ""}`);
  }
}

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function req<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  init?: { isFormData?: boolean },
): Promise<T> {
  if (!BASE_URL) {
    throw new Error("EXPO_PUBLIC_API_URL not configured (apps/driver/.env.local)");
  }
  const token = await getToken();
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  let payload: BodyInit | undefined;
  if (init?.isFormData) {
    payload = body as BodyInit;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload });
  if (!res.ok) {
    let detail: unknown;
    const text = await res.text();
    try { detail = JSON.parse(text); } catch { detail = text; }
    throw new ApiError(res.status, detail);
  }
  // 204 / no body — return undefined cast to T (callers handle this)
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as T;
}

// ── Driver identity ────────────────────────────────────────────────────

export interface DriverMeResponse {
  driverId:        number;
  orgId:           string;
  name:            string;
  firstName?:      string;
  lastName?:       string;
  phone:           string;
  email?:          string;
  address?:        string;
  licenseNumber?:  string;
  licenseState?:   string;
  licenseExp?:     string;
  medicalCardExp?: string;
  dob?:            string;
  notes?:          string;
}

export interface DriverProfileUpdate {
  firstName?:      string | null;
  lastName?:       string | null;
  phone?:          string | null;
  email?:          string | null;
  address?:        string | null;
  licenseNumber?:  string | null;
  licenseState?:   string | null;
  licenseExp?:     string | null;
  medicalCardExp?: string | null;
  dob?:            string | null;
}

export const railway = {
  // Identity
  me() { return req<DriverMeResponse>("GET", "/v1/driver/me"); },
  updateMe(body: DriverProfileUpdate) {
    return req<{ ok: true }>("PATCH", "/v1/driver/me", body);
  },

  // Driver documents (self)
  listMyDocuments() {
    return req<{ documents: import("@fleetcal/types").DriverDocument[] }>(
      "GET", "/v1/driver/documents",
    );
  },
  uploadMyDocument(form: FormData) {
    return req<{ document: import("@fleetcal/types").DriverDocument }>(
      "POST", "/v1/driver/documents", form, { isFormData: true },
    );
  },
  deleteMyDocument(id: string) {
    return req<{ ok: true }>("DELETE", `/v1/driver/documents/${id}`);
  },

  // Mark all informational notifications (assigned, reassigned_away)
  // as viewed. Called when the driver opens the bell so the red badge
  // clears for pings they've now seen. Action-required pings (confirm,
  // upload_pod) are left pending — those clear when the driver does
  // the actual action.
  markNotificationsViewed() {
    return req<{ ok: true }>("POST", "/v1/driver/notifications/mark-viewed");
  },

  /** Report current OS-level permission state to the API so dispatch
   *  can see whether the driver can actually receive pushes / has GPS
   *  consent. Pass undefined for any field that isn't supported on the
   *  current platform (e.g. notifications on web). */
  reportPermissions(body: {
    notifications?: "granted" | "denied" | "undetermined" | null;
    location?:      "granted" | "denied" | "undetermined" | null;
  }) {
    return req<{ ok: true }>("POST", "/v1/driver/permissions", body);
  },

  // Register/refresh this device's Expo push token. Goes through Railway
  // (service-role) instead of a direct Supabase upsert, which the
  // 2026-06-11 RLS lockdown broke for the driver's OTP-auth'd client.
  registerPushToken(body: { token: string; platform: "ios" | "android" }) {
    return req<{ ok: true }>("POST", "/v1/driver/push-token", body);
  },

  // Notifications inbox — every push the driver has been sent in the
  // last 48h (default). Includes acknowledgement state so the UI can
  // distinguish "still pending action" from "done."
  listMyNotifications(opts?: { hours?: number; limit?: number }) {
    const qs = new URLSearchParams();
    if (opts?.hours != null) qs.set("hours", String(opts.hours));
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return req<{
      notifications: {
        id:             string;
        eventId:        string;
        loadId:         string | null;
        loadNum:        string | null;
        loadTitle:      string | null;
        kind:           string;
        sentAt:         string;
        sentByName:     string;
        acknowledgedAt: string | null;
      }[];
    }>("GET", `/v1/driver/notifications${q ? `?${q}` : ""}`);
  },

  // Loads
  listLoads(query?: { from?: string; to?: string }) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(query ?? {}).filter(([, v]) => v != null)) as Record<string, string>,
    ).toString();
    return req<{ loads: unknown[] }>("GET", `/v1/driver/loads${qs ? `?${qs}` : ""}`);
  },
  getLoad(id: string) { return req<{ load: unknown }>("GET", `/v1/driver/loads/${id}`); },
  updateLoad(id: string, body: { status?: string; trailerId?: number | null }) {
    return req<{ ok: true }>("PATCH", `/v1/driver/loads/${id}`, body);
  },
  /**
   * Driver taps Confirm on an assigned load. Idempotent — calling it on
   * an already-confirmed load just returns the existing timestamp.
   */
  confirmLoad(id: string) {
    return req<{ ok: true; confirmedAt: string }>("POST", `/v1/driver/loads/${id}/confirm`);
  },

  // Stops
  checkInStop(stopId: string, body: { lat: number; lng: number; distanceMi?: number }) {
    return req<{ ok: true }>("POST", `/v1/driver/stops/${stopId}/check-in`, body);
  },
  checkOutStop(stopId: string) {
    return req<{ ok: true }>("POST", `/v1/driver/stops/${stopId}/check-out`);
  },

  /** Truck location for a specific load (returns 404 when no ELD bound).
   *  Pass `{ force: true }` to bypass the API's per-org Motive cache
   *  and trigger a fresh fetch from Motive — used by the manual
   *  refresh button on the AssignedTruckCard. */
  getTruckLocation(loadId: string, opts?: { force?: boolean }) {
    const q = opts?.force ? "?force=true" : "";
    return req<{ lat: number; lon: number; locatedAt: string; description: string; color: string | null }>(
      "GET",
      `/v1/driver/loads/${loadId}/truck-location${q}`,
    );
  },

  /** Relay handoff: pickup-leg driver pins the actual trailer-drop
   *  location with their phone GPS. The delivery-leg driver then reads
   *  it back via partnerTrailerDropoff* on the load detail. Endpoint
   *  rejects with 400 if the event isn't a relay pickup. */
  saveTrailerDropoff(eventId: string, body: { lat: number; lng: number }) {
    return req<{ trailerDropoffLat: number; trailerDropoffLng: number; trailerDropoffAt: string }>(
      "POST",
      `/v1/driver/events/${eventId}/trailer-dropoff`,
      body,
    );
  },

  // Documents
  listDocuments(loadId: string) {
    return req<{ documents: unknown[] }>("GET", `/v1/driver/loads/${loadId}/documents`);
  },
  uploadDocument(loadId: string, form: FormData) {
    return req<{ document: unknown }>("POST", `/v1/driver/loads/${loadId}/documents`, form, { isFormData: true });
  },
  /** Delete a LOAD-attached document. The matching profile-document
   *  delete is `deleteMyDocument` above (DELETE /v1/driver/documents/:id).
   *  The two paths used to collide — keep them distinct. */
  deleteDocument(id: string) {
    return req<{ ok: true }>("DELETE", `/v1/driver/loads/documents/${id}`);
  },
  /** Re-categorize a document's kind. Kind-only by design — filename
   *  stays auto-generated server-side. Server restricts the kind to
   *  the org's driver-allowed list (and hard-blocks rate_con/invoice
   *  even if mis-allowed). */
  updateDocumentKind(id: string, kind: string) {
    return req<{ document: unknown }>("PATCH", `/v1/driver/loads/documents/${id}`, { kind });
  },
  getDocumentUrl(id: string) {
    return req<{ url: string }>("GET", `/v1/driver/loads/documents/${id}/url`);
  },

  // Org settings + assets + trailers
  getOrgSettings() {
    return req<{
      settings: {
        showDriverPay:     boolean;
        timezone:          string | null;
        /** Kinds the driver app may show + accept on upload. Resolved
         *  server-side from org_settings.document_types (enabled AND
         *  driver_visible) with a legacy fallback. */
        driverUploadKinds: string[];
        /** Org module flags (MVP defaults merged server-side). Gates the
         *  Report tab / inspections / compliance per org. */
        modules:           import("@fleetcal/types").OrgModuleFlags | null;
        /** Curzon-only Truck History module — gates "View truck history" +
         *  "Post-Trip Inspection" surfaces. */
        truckHistoryEnabled?: boolean;
      };
    }>("GET", "/v1/driver/org-settings");
  },
  getScorecard() {
    return req<import("@fleetcal/types").DriverScorecardResponse>("GET", "/v1/driver/scorecard");
  },
  listAssets() {
    return req<{
      assets: { id: number; name: string; unit?: string; truck?: string; color: string; type: string }[];
    }>("GET", "/v1/driver/assets");
  },
  suggestedAsset() {
    return req<{ assetId: number | null; source: "event" | "preference" | null }>(
      "GET",
      "/v1/driver/suggested-asset",
    );
  },
  listTrailers() {
    return req<{ trailers: { id: number; name: string; trailerNumber?: string; category: string }[] }>(
      "GET",
      "/v1/driver/trailers",
    );
  },

  // Fuel reports
  submitFuelReport(body: {
    assetId:        number;
    state:          string;        // 2-letter US abbr
    dieselGallons:  number;
    defGallons?:    number;
    odometer?:      number;
    reportedAt?:    string;
    latitude?:      number;
    longitude?:     number;
  }) {
    return req<{ fuelReport: import("@fleetcal/types").FuelReport }>(
      "POST",
      "/v1/driver/fuel-reports",
      body,
    );
  },
  uploadFuelReceipt(reportId: string, form: FormData) {
    return req<{ photo: { id: string; file_name: string; mime_type: string | null; size_bytes: number | null; uploaded_at: string } }>(
      "POST",
      `/v1/driver/fuel-reports/${reportId}/photos`,
      form,
      { isFormData: true },
    );
  },
  listFuelReports(limit = 20) {
    return req<{ fuelReports: import("@fleetcal/types").FuelReport[] }>(
      "GET",
      `/v1/driver/fuel-reports?limit=${limit}`,
    );
  },

  // Maintenance reports
  submitMaintenanceReport(body: {
    assetId?:    number;
    trailerId?:  number;
    description: string;
    reportedAt?: string;
    latitude?:   number;
    longitude?:  number;
    state?:      string;
    /** Set when this report is spawned from a failed inspection item
     *  (step 3 of the pre/post-trip flow). */
    source?:             "inspection";
    inspectionReportId?: string;
    inspectionItemId?:   string;
  }) {
    return req<{ report: import("@fleetcal/types").MaintenanceReport }>(
      "POST",
      "/v1/driver/maintenance-reports",
      body,
    );
  },
  uploadMaintenancePhoto(reportId: string, form: FormData) {
    return req<{ photo: { id: string; file_name: string; mime_type: string | null; size_bytes: number | null; uploaded_at: string } }>(
      "POST",
      `/v1/driver/maintenance-reports/${reportId}/photos`,
      form,
      { isFormData: true },
    );
  },
  listMyMaintenanceReports(limit = 20) {
    return req<{ reports: import("@fleetcal/types").MaintenanceReport[] }>(
      "GET",
      `/v1/driver/maintenance-reports/mine?limit=${limit}`,
    );
  },
  listMaintenanceHistory(target: { assetId?: number; trailerId?: number }, limit = 10) {
    const qs = new URLSearchParams();
    if (target.assetId   != null) qs.set("assetId",   String(target.assetId));
    if (target.trailerId != null) qs.set("trailerId", String(target.trailerId));
    qs.set("limit", String(limit));
    return req<{ reports: import("@fleetcal/types").MaintenanceReport[] }>(
      "GET",
      `/v1/driver/maintenance-reports/history?${qs.toString()}`,
    );
  },
  getNotificationPrefs() {
    return req<{ prefs: Record<string, boolean> }>("GET", `/v1/driver/notification-prefs`);
  },
  setNotificationPref(ruleKey: string, enabled: boolean | null) {
    return req<{ prefs: Record<string, boolean> }>(
      "PATCH",
      `/v1/driver/notification-prefs`,
      { ruleKey, enabled },
    );
  },

  /** Submit one inspection report. Returns the saved row.
   *  durationSeconds = wall clock from form open to submit (compliance
   *  signal — rubber-stamping a 59-item list takes about 8 s).
   *  locationLat/Lon = GPS at submit (proves the driver was with the
   *  truck and gives DOT a coord for any roadside follow-up). */
  submitInspection(body: {
    assetId?:         number | null;
    trailerId?:       number | null;
    /** Pre-trip (default) or post-trip end-of-shift condition pass. */
    kind?:            "pre_trip" | "post_trip";
    items:            InspectionItemPayload[];
    trailerItems?:    InspectionItemPayload[];
    notes?:           string;
    signedBy?:        string;
    durationSeconds?: number | null;
    locationLat?:     number | null;
    locationLon?:     number | null;
  }) {
    return req<{ inspection: { id: string; submitted_at: string; has_defects: boolean; kind?: string } }>(
      "POST", "/v1/driver/inspections", body,
    );
  },
  /** Truck History module (Curzon-only). Aggregated history for one truck
   *  or trailer: recent driver events, known damage, recent inspection
   *  defects, and the last cleanliness photo. 404s when the module is off. */
  getEquipmentHistory(kind: "asset" | "trailer", id: number) {
    return req<EquipmentHistory>(
      "GET", `/v1/driver/equipment/${kind}/${id}/history`,
    );
  },
  /** Upload one photo against an existing inspection. Pass `itemId`
   *  to tie it to a specific failed checklist row, or omit it for a
   *  general photo (truck nameplate, odometer, etc.). */
  uploadInspectionPhoto(reportId: string, form: FormData) {
    return req<{ photo: { id: string; item_id: string | null; storage_path: string; caption: string | null; uploaded_at: string } }>(
      "POST",
      `/v1/driver/inspections/${reportId}/photos`,
      form,
      { isFormData: true },
    );
  },
  /** Inspections this driver has submitted today (driver's UTC date).
   *  Drives the schedule-tab card state. */
  todaysInspections() {
    return req<{ inspections: TodayInspectionSummary[] }>(
      "GET", "/v1/driver/inspections/today",
    );
  },
};

export interface InspectionItemPayload {
  id:      string;
  section: string;
  label:   string;
  status:  "pass" | "fail" | "na";
  notes?:  string;
}

export interface EquipmentPhoto {
  id:         string;
  fileName?:  string;
  caption?:   string | null;
  itemId?:    string | null;
  uploadedAt: string;
  signedUrl?: string;
}

export interface EquipmentHistory {
  recentEvents: Array<{
    id: string; driverName: string | null; start: string; end: string;
    status: string; title: string; loadNum: string | null; internalLoadId: number | null;
  }>;
  knownDamage: Array<{
    source: "action_item" | "report"; id: string; title: string | null;
    description: string | null; priority: string | null; status: string;
    outOfService: boolean; reportedAt: string; fromInspection: boolean;
    photos: EquipmentPhoto[];
  }>;
  recentInspectionDefects: Array<{
    id: string; kind: string; date: string; signedBy: string;
    cleanlinessFlagged: boolean;
    failedItems: Array<{ id: string; label: string; section: string; notes: string | null }>;
    photos: EquipmentPhoto[];
  }>;
  lastCleanlinessPhoto: { signedUrl?: string; uploadedAt: string; date: string; signedBy: string } | null;
}

export interface TodayInspectionSummary {
  id:               string;
  asset_id:         number | null;
  trailer_id:       number | null;
  /** 'pre_trip' | 'post_trip' — drives the per-driver-per-day green state
   *  on each half of the inspection card. Older rows default to 'pre_trip'. */
  kind:             "pre_trip" | "post_trip";
  inspection_date:  string;
  has_defects:      boolean;
  submitted_at:     string;
  signed_by:        string;
  asset?:           { name: string; unit: string | null } | null;
  trailer?:         { name: string; trailer_number: string | null } | null;
}
