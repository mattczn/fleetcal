import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ShieldAlert } from "lucide-react-native";
import { supabase } from "@/lib/supabase";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

export default function NotFoundScreen() {
  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a2332" }}>
      <View style={{ flex: 1, paddingHorizontal: 26, justifyContent: "center" }}>
        <View
          style={{
            width: 56, height: 56, borderRadius: 16,
            backgroundColor: "rgba(234,67,53,0.12)",
            alignItems: "center", justifyContent: "center",
            marginBottom: 20,
            borderWidth: 1, borderColor: "rgba(234,67,53,0.3)",
          }}
        >
          <ShieldAlert size={28} color="#ea4335" strokeWidth={2.2} />
        </View>

        <Text style={[txt(800), { fontSize: 28, color: "#ffffff", letterSpacing: -0.4 }]}>
          Account not found
        </Text>
        <Text
          style={[
            txt(500),
            { fontSize: 15, color: "rgba(255,255,255,0.6)", lineHeight: 22, marginTop: 10, marginBottom: 32 },
          ]}
        >
          This phone number isn&apos;t linked to a driver account. Ask dispatch to add
          your number to your profile, then try signing in again.
        </Text>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={handleSignOut}
          style={{
            backgroundColor: "rgba(255,255,255,0.08)",
            borderColor: "rgba(255,255,255,0.18)",
            borderWidth: 1,
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: "center",
          }}
        >
          <Text style={[txt(700), { color: "#ffffff", fontSize: 14 }]}>
            Use a different number
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
