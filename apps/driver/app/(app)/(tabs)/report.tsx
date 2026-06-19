/**
 * Report tab — bundles Fuel and Maintenance forms under one tab with a
 * segmented header. The two underlying screens (FuelFormScreen,
 * MaintenanceFormScreen) live in components/ and do their own data
 * fetching + state; this tab owns the segment state + the header chrome.
 */
import React, { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Fuel, Wrench } from "lucide-react-native";

import FuelFormScreen from "@/components/FuelFormScreen";
import MaintenanceFormScreen from "@/components/MaintenanceFormScreen";
import { Glass } from "@/components/Glass";
import { f, SP, RADIUS } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

type Segment = "fuel" | "maintenance";

export default function ReportScreen() {
  const insets = useSafeAreaInsets();
  const { C, isDark } = useTheme();
  const [segment, setSegment] = useState<Segment>("fuel");

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style={isDark ? "light" : "dark"} />

      <Glass
        deep
        radii={{ borderBottomLeftRadius: RADIUS.headerList, borderBottomRightRadius: RADIUS.headerList }}
        style={{ paddingTop: insets.top + 8, paddingHorizontal: SP.screenPx, paddingBottom: 12, zIndex: 10 }}
      >
        <Text style={[f(800), { fontSize: 27, color: C.t1, letterSpacing: -0.6 }]}>Reports</Text>
        <View style={{ flexDirection: "row", gap: 3, marginTop: 14, padding: 4, borderRadius: 14, backgroundColor: C.surfaceSunk }}>
          <Seg label="Fuel" Icon={Fuel} active={segment === "fuel"} onPress={() => setSegment("fuel")} />
          <Seg label="Maintenance" Icon={Wrench} active={segment === "maintenance"} onPress={() => setSegment("maintenance")} />
        </View>
      </Glass>

      {/* Render BOTH screens at all times so in-progress input (description,
          photos, picker selections) survives flipping segments. */}
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ flex: 1, display: segment === "fuel" ? "flex" : "none" }}>
          <FuelFormScreen />
        </View>
        <View style={{ flex: 1, display: segment === "maintenance" ? "flex" : "none" }}>
          <MaintenanceFormScreen />
        </View>
      </View>
    </View>
  );
}

function Seg({
  label, Icon, active, onPress,
}: {
  label: string; Icon: typeof Fuel; active: boolean; onPress: () => void;
}) {
  const { C, SHADOW, ACCENT_INK } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[
        { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 36, borderRadius: 11 },
        active && { backgroundColor: C.surface, ...SHADOW.card },
      ]}
    >
      <Icon size={15} color={active ? ACCENT_INK : C.t3} strokeWidth={2.4} />
      <Text style={[f(700), { fontSize: 13, color: active ? C.t1 : C.t3, letterSpacing: 0.1 }]}>{label}</Text>
    </TouchableOpacity>
  );
}
