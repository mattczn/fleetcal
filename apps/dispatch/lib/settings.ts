import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@clerk/clerk-expo";
import { railway } from "./railway";

const KEY_DRIVER_PAY_PCT = "settings:driverPayPct";

/**
 * Last-resort default, used ONLY when the org's real setting can't be
 * reached (no network, no cached copy yet). It is not a policy — an org
 * that pays 30% and had this app quietly compute 25% produced driver
 * pay that disagreed with every other surface in the product.
 */
export const FALLBACK_DRIVER_PAY_PCT = 25;

/**
 * The org's configured driver-pay percentage.
 *
 * Source of truth is `org_settings.rate_con_settings.driverPayPct` —
 * the same value the web Settings page writes and the API's create-load
 * auto-fill reads. AsyncStorage is now only an offline CACHE of the last
 * value the server gave us, not an independent per-device setting.
 *
 * Returns `null` when the org has deliberately not configured a
 * percentage: that means "don't auto-compute driver pay", exactly as it
 * does on web. Callers must treat null as "leave driver pay alone"
 * rather than substituting a number of their own.
 *
 * NOTE: this is the percentage OF the load price for a single-leg load.
 * The dispatch app only creates single-leg loads; if it ever grows relay
 * creation, the base becomes that LEG's share of the price — see
 * apps/web/lib/legPay.ts, which is the shared rule on web.
 */
export function useDriverPayPct(): { pct: number | null; isLoading: boolean } {
  const { organization } = useOrganization();
  const orgId = organization?.id;

  const [cached, setCached] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(KEY_DRIVER_PAY_PCT)
      .then((raw) => {
        if (cancelled || raw == null) return;
        const n = parseFloat(raw);
        if (Number.isFinite(n)) setCached(n);
      })
      .catch(() => { /* cache miss is not an error — the query covers us */ });
    return () => { cancelled = true; };
  }, []);

  const q = useQuery({
    queryKey: ["org-settings", "driverPayPct", orgId],
    queryFn: async () => {
      const { settings } = await railway.getOrgSettings();
      const v = settings?.rateConSettings?.driverPayPct;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    },
    enabled:   !!orgId,
    staleTime: 60 * 60 * 1000, // changes maybe once in an org's lifetime
  });

  // Mirror the server value into the cache so the next cold start (or a
  // trip through a dead zone) opens with the org's real number.
  useEffect(() => {
    if (q.data == null) return;
    void AsyncStorage.setItem(KEY_DRIVER_PAY_PCT, String(q.data));
  }, [q.data]);

  // Resolved → the org's answer, including a deliberate null.
  // Unresolved → last known value, then the literal fallback.
  const pct = q.isSuccess ? q.data : (cached ?? FALLBACK_DRIVER_PAY_PCT);

  return { pct, isLoading: q.isLoading };
}
