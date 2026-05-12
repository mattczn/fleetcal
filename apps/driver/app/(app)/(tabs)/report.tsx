/**
 * Report tab — bundles Fuel and Maintenance forms under one tab with
 * a segmented header. The two underlying screens (FuelFormScreen,
 * MaintenanceFormScreen) live in components/ and do their own data
 * fetching + state management; this tab only owns the segment state
 * and the blue header chrome.
 */
import React, { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Fuel, Wrench } from "lucide-react-native";

import FuelFormScreen from "@/components/FuelFormScreen";
import MaintenanceFormScreen from "@/components/MaintenanceFormScreen";

type Segment = "fuel" | "maintenance";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

export default function ReportScreen() {
  const [segment, setSegment] = useState<Segment>("fuel");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }} edges={["top"]}>
      {/* Blue top bar with title + segmented control. */}
      <View style={{ backgroundColor: "#1a73e8", paddingHorizontal: 22, paddingTop: 8, paddingBottom: 16 }}>
        <Text style={[txt(800), { fontSize: 22, color: "#fff", letterSpacing: -0.3, marginBottom: 12 }]}>
          Submit a Report
        </Text>
        <View style={{
          flexDirection: "row",
          backgroundColor: "rgba(255,255,255,0.14)",
          borderRadius: 10,
          padding: 4,
        }}>
          <Segment
            label="Fuel"
            Icon={Fuel}
            active={segment === "fuel"}
            onPress={() => setSegment("fuel")}
          />
          <Segment
            label="Maintenance"
            Icon={Wrench}
            active={segment === "maintenance"}
            onPress={() => setSegment("maintenance")}
          />
        </View>
      </View>

      {/* Render BOTH screens at all times so state (description,
          uploaded photos, picker selections) is preserved when the
          driver flips between segments without submitting. Toggle
          visibility with display:none — cheap, and avoids re-mounting
          which would lose in-progress input. */}
      <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
        <View style={{ flex: 1, display: segment === "fuel" ? "flex" : "none" }}>
          <FuelFormScreen />
        </View>
        <View style={{ flex: 1, display: segment === "maintenance" ? "flex" : "none" }}>
          <MaintenanceFormScreen />
        </View>
      </View>
    </SafeAreaView>
  );
}

function Segment({
  label, Icon, active, onPress,
}: {
  label: string;
  Icon: typeof Fuel;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 9,
        borderRadius: 8,
        backgroundColor: active ? "#fff" : "transparent",
      }}>
      <Icon size={14} color={active ? "#1a73e8" : "rgba(255,255,255,0.85)"} strokeWidth={2.4} />
      <Text style={[
        txt(700),
        { fontSize: 13, color: active ? "#1a73e8" : "rgba(255,255,255,0.85)", letterSpacing: 0.2 },
      ]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}
