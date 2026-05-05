/**
 * Driver-app org settings — pulls the subset the driver app actually
 * reads (currently just showDriverPay) from the Railway API.
 */
import { railway } from "@/lib/railway";

export interface OrgSettings {
  showDriverPay: boolean;
}

const DEFAULTS: OrgSettings = { showDriverPay: false };

export async function fetchOrgSettings(_orgId: string): Promise<OrgSettings> {
  try {
    const { settings } = await railway.getOrgSettings();
    return settings;
  } catch (err) {
    console.error("fetchOrgSettings:", err);
    return DEFAULTS;
  }
}
