/**
 * Driver-app org settings — pulls the subset the driver app actually
 * reads (currently just showDriverPay) from the Railway API.
 */
import { railway } from "@/lib/railway";
import type { OrgModuleFlags } from "@fleetcal/types";

export interface OrgSettings {
  showDriverPay: boolean;
  /** IANA tz the org's dispatch zone uses (e.g. "America/Denver").
   *  null when the org hasn't configured one — caller is expected to
   *  treat that as "tz info unavailable" and avoid device-tz fallback
   *  for "now"/"today" math. */
  timezone: string | null;
  /** Document kinds this driver may upload (and which the docs list
   *  will surface). Resolved server-side from the org's documentTypes
   *  config — only kinds where enabled && driverVisible appear here.
   *  rate_con + invoice are excluded by hard policy regardless of the
   *  org's config. */
  driverUploadKinds: string[];
  /** Org module flags (merged with MVP defaults server-side). null only
   *  before the first fetch — `isModuleEnabled` treats null as all-on, so
   *  nothing flashes hidden while loading. */
  modules: OrgModuleFlags | null;
}

const DEFAULTS: OrgSettings = {
  showDriverPay:     false,
  timezone:          null,
  // Default mirrors the server when settings haven't been fetched yet.
  driverUploadKinds: ["pod", "bol", "scale", "lumper", "receipt", "driver_sheet", "relay_handoff", "other"],
  modules:           null,
};

export async function fetchOrgSettings(_orgId: string): Promise<OrgSettings> {
  try {
    const { settings } = await railway.getOrgSettings();
    return settings;
  } catch (err) {
    console.error("fetchOrgSettings:", err);
    return DEFAULTS;
  }
}
