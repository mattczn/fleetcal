import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { railway } from "@/lib/railway";

/** Public status surfaced to the UI so the driver can see when push
 *  registration is broken (e.g. permission denied or upstream upsert
 *  failure) — silent failures were leaving drivers without any pings
 *  and no way to tell. */
export type PushRegistrationStatus =
  | "idle"          // hook not yet run / no driver session
  | "unsupported"   // simulator or non-device
  | "registering"   // in flight
  | "denied"        // OS permission denied
  | "failed"        // permission OK but token mint or DB upsert failed
  | "registered";   // success

const UPSERT_RETRIES = 3;
const UPSERT_BACKOFF_MS = 1500;

/**
 * Register the device's Expo push token under the signed-in driver.
 * Run once after driver session is matched. Tokens stored in
 * driver_push_tokens; the dispatch server fans out via Expo Push API
 * when a load is assigned/changed.
 *
 * Returns the live status of registration so screens can surface a
 * "push isn't working" banner when something goes wrong. Token upsert
 * is retried with backoff before declaring failure.
 */
export function usePushRegistration(
  driverId: number | undefined,
  orgId: string | undefined,
): PushRegistrationStatus {
  const [status, setStatus] = useState<PushRegistrationStatus>("idle");

  useEffect(() => {
    if (!driverId || !orgId) { setStatus("idle"); return; }
    if (!Device.isDevice) { setStatus("unsupported"); return; }
    let cancelled = false;

    (async () => {
      setStatus("registering");
      try {
        // Foreground notification handler — show banners while app is open
        Notifications.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowBanner: true,
            shouldShowList:   true,
            shouldPlaySound:  true,
            shouldSetBadge:   false,
          }),
        });

        const { status: existing } = await Notifications.getPermissionsAsync();
        let granted = existing === "granted";
        if (!granted) {
          const { status: askResult } = await Notifications.requestPermissionsAsync();
          granted = askResult === "granted";
        }
        if (!granted) { if (!cancelled) setStatus("denied"); return; }

        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ??
          (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
        const tokenRes = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        if (cancelled) return;
        const token = tokenRes.data;
        const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";

        // Register the token via Railway (service-role) instead of a
        // direct Supabase upsert. The 2026-06-11 RLS lockdown put an
        // org-scoped policy on driver_push_tokens keyed on the
        // `org_id` JWT claim — which the driver's Supabase phone-OTP
        // token doesn't carry — so the old direct upsert silently 403'd
        // and NO driver registered a token fleet-wide for ~10 days.
        // Railway resolves driver+org from the verified JWT and writes
        // with service-role, bypassing RLS. Retry on flaky cell.
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < UPSERT_RETRIES; attempt++) {
          if (cancelled) return;
          try {
            await railway.registerPushToken({ token, platform });
            if (!cancelled) setStatus("registered");
            return;
          } catch (err) {
            lastErr = err;
            if (attempt < UPSERT_RETRIES - 1) {
              await new Promise(r => setTimeout(r, UPSERT_BACKOFF_MS * (attempt + 1)));
            }
          }
        }
        console.error("usePushRegistration register (all retries failed):", lastErr);
        if (!cancelled) setStatus("failed");
      } catch (err) {
        // Push not configured (e.g. free Apple ID without aps-environment entitlement)
        // is expected on dev builds — log quietly so it doesn't drown the console.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("aps-environment")) {
          if (!cancelled) setStatus("unsupported");
          return;
        }
        console.warn("usePushRegistration:", msg);
        if (!cancelled) setStatus("failed");
      }
    })();

    return () => { cancelled = true; };
  }, [driverId, orgId]);

  return status;
}
