/**
 * Driver profile fetching.
 * Currently returns dummy data. Wire to Supabase `drivers` table later.
 */
import { DUMMY_DRIVER } from "@/constants/dummy-data";

export type DriverProfile = typeof DUMMY_DRIVER;

export async function fetchDriver(driverId?: string): Promise<DriverProfile> {
  // TODO: supabase.from("drivers").select("*").eq("id", driverId).single()
  void driverId;
  return DUMMY_DRIVER;
}

export async function updateDriver(
  driverId: string,
  updates: Partial<Omit<DriverProfile, "id">>
): Promise<DriverProfile> {
  // TODO: supabase.from("drivers").update(updates).eq("id", driverId)
  void driverId;
  return { ...DUMMY_DRIVER, ...updates };
}
