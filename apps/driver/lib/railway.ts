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
  driverId: number;
  orgId:    string;
  name:     string;
  phone:    string;
}

export const railway = {
  // Identity
  me() { return req<DriverMeResponse>("GET", "/v1/driver/me"); },

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

  // Stops
  checkInStop(stopId: string, body: { lat: number; lng: number; distanceMi?: number }) {
    return req<{ ok: true }>("POST", `/v1/driver/stops/${stopId}/check-in`, body);
  },
  checkOutStop(stopId: string) {
    return req<{ ok: true }>("POST", `/v1/driver/stops/${stopId}/check-out`);
  },

  // Truck location for a specific load (returns null when no ELD bound).
  getTruckLocation(loadId: string) {
    return req<{ lat: number; lon: number; locatedAt: string; description: string; color: string | null }>(
      "GET",
      `/v1/driver/loads/${loadId}/truck-location`,
    );
  },

  // Documents
  listDocuments(loadId: string) {
    return req<{ documents: unknown[] }>("GET", `/v1/driver/loads/${loadId}/documents`);
  },
  uploadDocument(loadId: string, form: FormData) {
    return req<{ document: unknown }>("POST", `/v1/driver/loads/${loadId}/documents`, form, { isFormData: true });
  },
  deleteDocument(id: string) {
    return req<{ ok: true }>("DELETE", `/v1/driver/documents/${id}`);
  },
  getDocumentUrl(id: string) {
    return req<{ url: string }>("GET", `/v1/driver/documents/${id}/url`);
  },

  // Org settings + assets + trailers
  getOrgSettings() {
    return req<{ settings: { showDriverPay: boolean } }>("GET", "/v1/driver/org-settings");
  },
  listAssets() {
    return req<{
      assets: { id: number; name: string; unit?: string; truck?: string; color: string; type: string }[];
    }>("GET", "/v1/driver/assets");
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
    notes?:         string;
  }) {
    return req<{ fuelReport: import("@fleetcal/types").FuelReport }>(
      "POST",
      "/v1/driver/fuel-reports",
      body,
    );
  },
  listFuelReports(limit = 20) {
    return req<{ fuelReports: import("@fleetcal/types").FuelReport[] }>(
      "GET",
      `/v1/driver/fuel-reports?limit=${limit}`,
    );
  },
};
