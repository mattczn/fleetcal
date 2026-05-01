import React from "react";
import { View, Text, TouchableOpacity, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useUser, useAuth, useOrganization } from "@clerk/clerk-expo";
import { ArrowLeft, LogOut, User, Building2, Mail, Trash2, ChevronRight } from "lucide-react-native";
import { txt } from "@/lib/font";

function Row({ Icon, label, value, last }: { Icon: typeof User; label: string; value: string; last?: boolean }) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center",
      paddingVertical: 13,
      borderBottomWidth: last ? 0 : 1, borderBottomColor: "#f1f3f4",
    }}>
      <Icon size={15} color="#5f6368" strokeWidth={2} />
      <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginLeft: 10, flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color: "#202124", maxWidth: "60%", textAlign: "right" }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useUser();
  const { organization } = useOrganization();
  const { signOut } = useAuth();

  const name  = user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress || "Dispatcher";
  const email = user?.primaryEmailAddress?.emailAddress ?? "—";
  const org   = organization?.name ?? "—";

  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {/* Header */}
      <View style={{ backgroundColor: "#1a73e8", paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <TouchableOpacity onPress={() => router.back()} activeOpacity={0.7}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}>
            <ArrowLeft size={18} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
          <Text style={[txt(800), { fontSize: 18, color: "#ffffff" }]}>Profile</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* Avatar block */}
        <View style={{ alignItems: "center", paddingVertical: 22 }}>
          <View style={{
            width: 88, height: 88, borderRadius: 26,
            backgroundColor: "#1a73e8",
            alignItems: "center", justifyContent: "center",
            shadowColor: "#1a73e8", shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
          }}>
            <Text style={[txt(800), { fontSize: 30, color: "#ffffff", letterSpacing: -0.5 }]}>
              {name.split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?"}
            </Text>
          </View>
          <Text style={[txt(800), { fontSize: 22, color: "#202124", marginTop: 12, letterSpacing: -0.3 }]}>
            {name}
          </Text>
          <Text style={[txt(500), { fontSize: 13, color: "#5f6368", marginTop: 2 }]}>
            {email}
          </Text>
        </View>

        {/* Account */}
        <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", textTransform: "uppercase", marginBottom: 10 }]}>
          Account
        </Text>
        <View style={{
          backgroundColor: "#ffffff", borderRadius: 14, paddingHorizontal: 14,
          borderWidth: 1, borderColor: "#e8eaed", marginBottom: 18,
        }}>
          <Row Icon={Mail}      label="Email"        value={email} />
          <Row Icon={Building2} label="Organization" value={org} last />
        </View>

        {/* Tools */}
        <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", textTransform: "uppercase", marginBottom: 10 }]}>
          Tools
        </Text>
        <TouchableOpacity
          onPress={() => router.push("/trash")}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", gap: 12,
            backgroundColor: "#ffffff",
            borderRadius: 14, borderWidth: 1, borderColor: "#e8eaed",
            paddingHorizontal: 14, paddingVertical: 14, marginBottom: 18,
          }}
        >
          <View style={{
            width: 34, height: 34, borderRadius: 11,
            backgroundColor: "#fef2f2",
            alignItems: "center", justifyContent: "center",
          }}>
            <Trash2 size={15} color="#b91c1c" strokeWidth={2.4} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[txt(800), { fontSize: 14, color: "#202124" }]}>Recently Deleted</Text>
            <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>
              Restore or permanently delete loads
            </Text>
          </View>
          <ChevronRight size={16} color="#9aa0a6" strokeWidth={2.2} />
        </TouchableOpacity>

        {/* Sign out */}
        <TouchableOpacity
          onPress={() => signOut()}
          activeOpacity={0.85}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            backgroundColor: "#fef2f2",
            borderWidth: 1, borderColor: "#fecaca",
            borderRadius: 14,
            paddingVertical: 14,
          }}
        >
          <LogOut size={16} color="#b91c1c" strokeWidth={2.4} />
          <Text style={[txt(800), { fontSize: 14, color: "#b91c1c", letterSpacing: 0.3 }]}>
            Sign out
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
