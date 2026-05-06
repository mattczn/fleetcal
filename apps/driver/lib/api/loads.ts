/**
 * Driver-app load helpers. Thin wrappers over /v1/driver/* that preserve
 * the old function signatures so callers don't have to change. The orgId
 * / driverId / changedByName arguments are ignored — the API derives all
 * three from the auth'd Supabase JWT.
 */
import { railway } from "@/lib/railway";
import type { Load, LoadStatus } from "@/lib/types";

/**
 * Fetch the driver's loads. By default, anything with `end >= 30 days ago`
 * comes back — older loads stay in the system but never load into the
 * driver app, keeping the cache + scroll length bounded.
 */
export async function fetchLoadsForDriver(
  _driverId: number,
  _orgId: string,
): Promise<Load[]> {
  try {
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const from =
      `${oneMonthAgo.getFullYear()}-${pad(oneMonthAgo.getMonth() + 1)}-${pad(oneMonthAgo.getDate())}` +
      `T${pad(oneMonthAgo.getHours())}:${pad(oneMonthAgo.getMinutes())}`;
    const { loads } = await railway.listLoads({ from });
    return loads as Load[];
  } catch (err) {
    console.error("fetchLoadsForDriver:", err);
    throw err;
  }
}

export async function fetchLoad(
  id: string,
  _driverId: number,
  _orgId: string,
): Promise<Load | null> {
  try {
    const { load } = await railway.getLoad(id);
    return load as Load;
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    if (status === 404) return null;
    console.error("fetchLoad:", err);
    return null;
  }
}

export async function updateLoadStatus(
  id: string,
  _orgId: string,
  status: LoadStatus,
  _prevStatus?: LoadStatus,
  _changedByName?: string,
): Promise<void> {
  await railway.updateLoad(id, { status });
}

export async function updateLoadTrailer(
  id: string,
  _orgId: string,
  trailerId: number | null,
): Promise<void> {
  await railway.updateLoad(id, { trailerId });
}

export async function checkInStop(
  stopId: string,
  _orgId: string,
  lat: number,
  lng: number,
  audit?: {
    eventId:       string;
    changedByName: string;
    stopFacility?: string;
    stopType?:     string;
    distanceMi?:   number;
  },
): Promise<void> {
  await railway.checkInStop(stopId, { lat, lng, distanceMi: audit?.distanceMi });
}

export async function undoCheckInStop(
  stopId: string,
  _orgId: string,
  _audit?: {
    eventId:       string;
    changedByName: string;
    stopFacility?: string;
    stopType?:     string;
  },
): Promise<void> {
  await railway.checkOutStop(stopId);
}

/**
 * No-op kept for back-compat. Audit entries used to be appended client-
 * side after status / trailer / check-in / document writes; the API now
 * handles that automatically using the auth'd driver name.
 */
export interface DriverAuditEntry {
  changedAt:      string;
  changedByName:  string;
  prevStatus?:    LoadStatus;
  newStatus?:     LoadStatus;
  documentUploaded?: { fileName: string; kind: string };
  documentDeleted?:  { fileName: string; kind: string };
  stopCheckedIn?:    { stopFacility?: string; stopType?: string; distanceMi?: number };
  stopCheckInUndone?: { stopFacility?: string; stopType?: string };
}
export async function appendEventAuditEntry(
  _eventId: string,
  _orgId:   string,
  _entry:   DriverAuditEntry,
): Promise<void> {
  // Server appends the audit entry inside the corresponding write
  // endpoint, so this is a no-op now. Keep the export so the existing
  // call sites still compile.
}

export async function fetchTrailers(
  _orgId: string,
): Promise<{ id: number; name: string; trailerNumber?: string; category: string }[]> {
  try {
    const { trailers } = await railway.listTrailers();
    return trailers;
  } catch (err) {
    console.error("fetchTrailers:", err);
    return [];
  }
}
