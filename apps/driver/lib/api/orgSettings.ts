import { supabase } from "@/lib/supabase";

export interface OrgSettings {
  showDriverPay: boolean;
}

const DEFAULTS: OrgSettings = { showDriverPay: false };

/**
 * Fetch org-level settings that control driver-app behavior.
 * Returns defaults when no row exists yet (default: hide pay).
 */
export async function fetchOrgSettings(orgId: string): Promise<OrgSettings> {
  const { data, error } = await supabase
    .from("org_settings")
    .select("show_driver_pay")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    // Pre-migration: table/column may not exist yet (Postgres 42P01 / 42703).
    // Treat as "no settings" silently so dev console isn't spammed.
    if (error.code !== "42P01" && error.code !== "42703") {
      console.error("fetchOrgSettings:", error);
    }
    return DEFAULTS;
  }
  if (!data) return DEFAULTS;
  return { showDriverPay: !!data.show_driver_pay };
}
