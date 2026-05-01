import { useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { supabase } from "@/lib/supabase";

/**
 * Register the device's Expo push token under the signed-in driver.
 * Run once after driver session is matched. Tokens stored in
 * driver_push_tokens; the dispatch server fans out via Expo Push API
 * when a load is assigned/changed.
 */
export function usePushRegistration(driverId: number | undefined, orgId: string | undefined) {
  useEffect(() => {
    if (!driverId || !orgId) return;
    if (!Device.isDevice) return; // simulators don't get push
    let cancelled = false;

    (async () => {
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
          const { status } = await Notifications.requestPermissionsAsync();
          granted = status === "granted";
        }
        if (!granted) return;

        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ??
          (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
        const tokenRes = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        if (cancelled) return;
        const token = tokenRes.data;
        const platform = Platform.OS === "ios" ? "ios" : "android";

        // Upsert: same token already exists → update last_seen_at
        const { error } = await supabase
          .from("driver_push_tokens")
          .upsert(
            {
              driver_id:    driverId,
              org_id:       orgId,
              token,
              platform,
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "token" },
          );
        if (error) console.error("usePushRegistration upsert:", error);
      } catch (err) {
        // Push not configured (e.g. free Apple ID without aps-environment entitlement)
        // is expected on dev builds — log quietly so it doesn't drown the console.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("aps-environment")) return;
        console.warn("usePushRegistration:", msg);
      }
    })();

    return () => { cancelled = true; };
  }, [driverId, orgId]);
}
