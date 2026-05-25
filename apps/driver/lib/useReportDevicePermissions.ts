/**
 * useReportDevicePermissions — reads the device's current notification +
 * location permission state via expo-notifications / expo-location and
 * reports it to the API (POST /v1/driver/permissions). Drives the
 * "Driver app: ✓ Location, ✗ Notifications" indicator in the dispatch
 * profile so dispatchers can spot drivers whose pushes won't reach
 * them or whose GPS-stamped events lack coords.
 *
 * Runs:
 *   1. Once on mount (after driver is signed in + matched).
 *   2. On every AppState transition into "active" — catches drivers
 *      who flip a permission in iOS Settings and come back to the app.
 *
 * Crucially uses get* (not request*) so we never trigger a permission
 * prompt as a side effect — that's the job of the feature that needs
 * the permission (push registration, location-stamped forms, etc.).
 * This hook only observes.
 */
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";
import * as Location from "expo-location";
import { railway } from "@/lib/railway";

type Perm = "granted" | "denied" | "undetermined";

function normalize(status: string | undefined | null): Perm | null {
  if (status === "granted" || status === "denied" || status === "undetermined") return status;
  return null;
}

export function useReportDevicePermissions(driverId: number | undefined): void {
  // Cache the last reported state so we skip the network round-trip
  // when nothing changed. Persists across renders within the session.
  const lastReportedRef = useRef<{ notifications: Perm | null; location: Perm | null }>({
    notifications: null, location: null,
  });

  useEffect(() => {
    if (!driverId) return;
    let cancelled = false;

    const checkAndReport = async () => {
      try {
        const [notifRes, locRes] = await Promise.allSettled([
          Notifications.getPermissionsAsync(),
          Location.getForegroundPermissionsAsync(),
        ]);
        if (cancelled) return;
        const notifications = notifRes.status === "fulfilled" ? normalize(notifRes.value.status) : null;
        const location      = locRes.status   === "fulfilled" ? normalize(locRes.value.status)   : null;

        // Skip the POST if nothing changed since last report. First run
        // always sends (because the cached state defaults to null/null).
        const prev = lastReportedRef.current;
        if (prev.notifications === notifications && prev.location === location) return;
        lastReportedRef.current = { notifications, location };

        await railway.reportPermissions({ notifications, location });
      } catch (err) {
        // Non-fatal — this is purely diagnostic for dispatch.
        console.warn("[reportPermissions]", err);
      }
    };

    // Fire on mount.
    void checkAndReport();

    // Re-check on every foreground transition.
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void checkAndReport();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [driverId]);
}
