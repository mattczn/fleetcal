/**
 * Driver-app module gating — mirrors the web's useModules.
 *
 * Reads the org's module flags (delivered by GET /v1/driver/org-settings,
 * already merged with MVP defaults server-side) and answers "does this org
 * have this feature?". Absent flags (before the first fetch) → everything
 * enabled, so nothing flashes hidden while settings load.
 *
 * MVP vs Curzon: new orgs default `fuel` + `maintenance` OFF (no Report
 * tab, no daily inspections, no compliance profile sections); Curzon keeps
 * them ON (the full app). Modules live in `org_settings.modules` keyed by
 * org_id — the same flags the dispatcher edits — so this works entirely off
 * the driver's Supabase session, with no Clerk involvement.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { isModuleEnabled, type OrgModule } from "@fleetcal/types";
import { useDriverSession } from "@/lib/useDriverSession";
import { fetchOrgSettings } from "@/lib/api/orgSettings";

export function useModules() {
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;
  const { data } = useQuery({
    queryKey: ["org-settings", driver?.orgId],
    queryFn:  () => fetchOrgSettings(driver!.orgId),
    enabled:  !!driver,
    staleTime: 5 * 60 * 1000,
  });
  const flags = data?.modules ?? null;
  const enabled = useCallback((m: OrgModule) => isModuleEnabled(m, flags), [flags]);

  // "Reporting" is the full-tier driver bundle: Fuel + Maintenance reports,
  // daily inspections (DVIR), and the Notifications preferences (those
  // toggles only matter for auto-generated reporting nudges). Gated on
  // either underlying module so a partial org config still surfaces what
  // it has.
  //
  // License + Compliance + Documents on the Profile screen used to live
  // under this gate too but were promoted to MVP on 2026-06-22 — small
  // carriers want CDL + medical card visibility from day one even before
  // the full reporting bundle unlocks.
  const reporting = enabled("fuel") || enabled("maintenance");

  return {
    enabled,
    reporting,
    fuel:        enabled("fuel"),
    maintenance: enabled("maintenance"),
  };
}
