/**
 * Driver-app org settings — pulls the subset the driver app actually
 * reads (currently just showDriverPay) from the Railway API.
 */
import { railway } from "@/lib/railway";

export interface OrgSettings {
  showDriverPay: boolean;
  /** IANA tz the org's dispatch zone uses (e.g. "America/Denver").
   *  null when the org hasn't configured one — caller is expected to
   *  treat that as "tz info unavailable" and avoid device-tz fallback
   *  for "now"/"today" math. */
  timezone: string | null;
}

const DEFAULTS: OrgSettings = { showDriverPay: false, timezone: null };

export async function fetchOrgSettings(_orgId: string): Promise<OrgSettings> {
  try {
    const { settings } = await railway.getOrgSettings();
    return settings;
  } catch (err) {
    console.error("fetchOrgSettings:", err);
    return DEFAULTS;
  }
}
