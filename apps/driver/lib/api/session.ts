import { supabase } from "@/lib/supabase";
import { normalizePhone } from "@/lib/phone";

export interface DriverSession {
  driverId: number;
  orgId:    string;
  name:     string;
  phone:    string;
}

/**
 * Look up the driver record matching the given phone number.
 * Returns null if no driver has that phone in any org.
 *
 * Phone is normalized first (E.164 +1XXXXXXXXXX) so it matches whatever
 * the web app stored — see lib/phone.ts.
 */
export async function fetchDriverByPhone(
  rawPhone: string,
): Promise<DriverSession | null> {
  const normalized = normalizePhone(rawPhone);
  console.log("[driver-lookup] raw=", rawPhone, "normalized=", normalized);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from("drivers")
    .select("id, org_id, name, phone")
    .eq("phone", normalized)
    .limit(1)
    .maybeSingle();

  console.log("[driver-lookup] query result:", { data, error });

  if (error) {
    console.error("fetchDriverByPhone:", error);
    return null;
  }
  if (!data) return null;

  return {
    driverId: data.id,
    orgId:    data.org_id,
    name:     data.name,
    phone:    data.phone,
  };
}
