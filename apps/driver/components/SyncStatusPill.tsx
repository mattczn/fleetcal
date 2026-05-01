import React, { useEffect, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Wifi, WifiOff } from "lucide-react-native";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

/**
 * A small pill that reflects sync state for the driver:
 *  - Syncing  → blue spinner + "Syncing"
 *  - Synced   → green dot + "Online"
 *  - Offline  → red icon + "Offline" (last fetch failed)
 *
 * Uses the react-query cache as the source of truth — no NetInfo dependency.
 */
export function SyncStatusPill() {
  const isFetching = useIsFetching();
  const qc = useQueryClient();
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const cache = qc.getQueryCache();
    let pending = 0;
    const unsub = cache.subscribe(() => {
      // The cache subscriber can fire mid-render of another component (e.g.
      // when a useQuery first registers). Deferring the setState to the next
      // tick avoids "setState during render" warnings while still reflecting
      // the new state quickly.
      if (pending) return;
      pending = setTimeout(() => {
        pending = 0;
        let anyErr = false;
        let anyRecentSuccess = false;
        for (const q of cache.getAll()) {
          if (q.state.status === "error") anyErr = true;
          if (q.state.status === "success" && q.state.dataUpdatedAt > q.state.errorUpdatedAt) {
            anyRecentSuccess = true;
          }
        }
        setHasError(anyErr && !anyRecentSuccess);
      }, 0) as unknown as number;
    });
    return () => {
      unsub();
      if (pending) clearTimeout(pending);
    };
  }, [qc]);

  const state: "syncing" | "online" | "offline" =
    isFetching > 0 ? "syncing" : hasError ? "offline" : "online";

  const palette =
    state === "syncing"
      ? { bg: "rgba(255,255,255,0.16)",      fg: "#ffffff" }
      : state === "online"
      ? { bg: "rgba(34,197,94,0.22)",        fg: "#bbf7d0" }
      : { bg: "rgba(220,38,38,0.28)",        fg: "#fecaca" };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: palette.bg,
      }}
    >
      {state === "syncing" ? (
        <ActivityIndicator size={11} color={palette.fg} />
      ) : state === "online" ? (
        <Wifi size={11} color={palette.fg} strokeWidth={2.6} />
      ) : (
        <WifiOff size={11} color={palette.fg} strokeWidth={2.6} />
      )}
      <Text style={[txt(800), { fontSize: 11, color: palette.fg, letterSpacing: 0.4 }]}>
        {state === "syncing" ? "Syncing" : state === "online" ? "Online" : "Offline"}
      </Text>
    </View>
  );
}
