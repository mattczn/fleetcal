import React from "react";
import { View, Text } from "react-native";
import { Wifi, WifiOff } from "lucide-react-native";
import { useOnline } from "@/lib/useOnline";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

/**
 * Binary online/offline pill driven by NetInfo. Treats the null
 * (probing / module-not-loaded) state as online so we don't flash an
 * offline indicator at startup — once NetInfo answers, it'll flip if
 * the radio is actually off.
 */
export function SyncStatusPill() {
  const online = useOnline();
  const offline = online === false;

  const palette = offline
    ? { bg: "rgba(220,38,38,0.28)", fg: "#fecaca" }
    : { bg: "rgba(34,197,94,0.22)", fg: "#bbf7d0" };

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
      {offline ? (
        <WifiOff size={11} color={palette.fg} strokeWidth={2.6} />
      ) : (
        <Wifi size={11} color={palette.fg} strokeWidth={2.6} />
      )}
      <Text style={[txt(800), { fontSize: 11, color: palette.fg, letterSpacing: 0.4 }]}>
        {offline ? "Offline" : "Online"}
      </Text>
    </View>
  );
}
