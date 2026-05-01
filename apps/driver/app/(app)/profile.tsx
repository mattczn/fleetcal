import React from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Phone, BadgeCheck, Building2, Info, LogOut, User } from "lucide-react-native";
import { supabase } from "@/lib/supabase";
import { useDriverSession } from "@/lib/useDriverSession";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

function Row({
  Icon, label, value,
}: {
  Icon: typeof Phone; label: string; value: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: "#f1f3f4",
      }}
    >
      <View
        style={{
          width: 32, height: 32, borderRadius: 10,
          backgroundColor: "#e8f0fe",
          alignItems: "center", justifyContent: "center",
          marginRight: 12,
        }}
      >
        <Icon size={16} color="#1a73e8" strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[txt(600), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4 }]}>
          {label.toUpperCase()}
        </Text>
        <Text style={[txt(700), { fontSize: 14, color: "#202124", marginTop: 2 }]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <Text
      style={[
        txt(800),
        {
          fontSize: 11,
          letterSpacing: 1.1,
          color: "#5f6368",
          marginBottom: 10,
          marginTop: 6,
          textTransform: "uppercase",
        },
      ]}
    >
      {label}
    </Text>
  );
}

export default function ProfileScreen() {
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;
  const initials = (driver?.name ?? "?")
    .split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();

  function handleSignOut() {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => { await supabase.auth.signOut(); },
      },
    ]);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }} edges={["top"]}>
      {/* Header */}
      <View style={{ backgroundColor: "#1a73e8", paddingTop: 8, paddingBottom: 28, alignItems: "center" }}>
        <View
          style={{
            width: 84, height: 84, borderRadius: 26,
            backgroundColor: "#1a73e8",
            alignItems: "center", justifyContent: "center",
            marginBottom: 12,
            shadowColor: "#1a73e8",
            shadowOpacity: 0.45,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 6 },
          }}
        >
          {initials !== "?" ? (
            <Text style={[txt(800), { fontSize: 30, color: "#ffffff", letterSpacing: -0.5 }]}>
              {initials}
            </Text>
          ) : (
            <User size={36} color="#ffffff" strokeWidth={2.2} />
          )}
        </View>
        <Text style={[txt(800), { fontSize: 22, color: "#ffffff", letterSpacing: -0.3 }]}>
          {driver?.name ?? "—"}
        </Text>
        <Text style={[txt(500), { fontSize: 13, color: "rgba(255,255,255,0.55)", marginTop: 2 }]}>
          {driver?.phone ?? "—"}
        </Text>
      </View>

      <ScrollView style={{ flex: 1, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <SectionHeader label="Account" />
        <View
          style={{
            backgroundColor: "#ffffff",
            borderRadius: 14,
            paddingHorizontal: 14,
            borderWidth: 1, borderColor: "#e8eaed",
            marginBottom: 18,
          }}
        >
          <Row Icon={BadgeCheck} label="Driver ID" value={driver ? `#${driver.driverId}` : "—"} />
          <Row Icon={Phone}      label="Phone"     value={driver?.phone ?? "—"} />
        </View>

        <SectionHeader label="App" />
        <View
          style={{
            backgroundColor: "#ffffff",
            borderRadius: 14,
            paddingHorizontal: 14,
            borderWidth: 1, borderColor: "#e8eaed",
            marginBottom: 24,
          }}
        >
          <Row Icon={Info}       label="Version" value="1.0.0" />
          <Row Icon={Building2}  label="Company" value="Curzon Trucking" />
        </View>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={handleSignOut}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            paddingVertical: 16,
            backgroundColor: "#fef2f2",
            borderRadius: 14,
            borderWidth: 1, borderColor: "#fecaca",
          }}
        >
          <LogOut size={16} color="#b91c1c" strokeWidth={2.2} />
          <Text style={[txt(800), { fontSize: 14, color: "#b91c1c", letterSpacing: 0.2 }]}>
            Sign Out
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
