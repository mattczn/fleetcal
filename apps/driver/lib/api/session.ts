/**
 * Driver session lookup — calls /v1/driver/me with the active Supabase
 * access token. The API verifies the JWT, resolves the phone claim to a
 * drivers row, and returns the driver identity.
 */
import { railway } from "@/lib/railway";

export interface DriverSession {
  driverId: number;
  orgId:    string;
  name:     string;
  phone:    string;
}

export async function fetchDriverByPhone(
  // Param kept for back-compat with the old call site; ignored — the
  // server now resolves identity from the JWT, not a client-supplied phone.
  _rawPhone: string,
): Promise<DriverSession | null> {
  try {
    const me = await railway.me();
    return {
      driverId: me.driverId,
      orgId:    me.orgId,
      name:     me.name,
      phone:    me.phone,
    };
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    // 404 means the auth'd phone isn't bound to any drivers row yet.
    if (status === 404) return null;
    console.error("fetchDriverByPhone:", err);
    return null;
  }
}
