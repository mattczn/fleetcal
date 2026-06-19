import React from "react";
import { View, Text } from "react-native";
import { useOnline } from "@/lib/useOnline";
import { f } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

/**
 * Online/offline pill driven by NetInfo. Treats the null (probing /
 * module-not-loaded) state as online so we don't flash an offline
 * indicator at startup. Styled for the light glass header: a green dot +
 * "Synced", flipping to a red dot + "Offline" when the radio is off.
 */
export function SyncStatusPill() {
  const online = useOnline();
  const { C } = useTheme();
  const offline = online === false;
  const p = offline
    ? { bg: C.redBg, fg: C.redInk, dot: C.red }
    : { bg: C.greenBg, fg: C.greenInk, dot: C.green };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 30,
        paddingHorizontal: 11,
        borderRadius: 999,
        backgroundColor: p.bg,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: p.dot }} />
      <Text style={[f(700), { fontSize: 11.5, color: p.fg, letterSpacing: 0.1 }]}>
        {offline ? "Offline" : "Synced"}
      </Text>
    </View>
  );
}
