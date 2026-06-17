import React from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useOAuth, useAuth } from "@clerk/clerk-expo";
import * as WebBrowser from "expo-web-browser";
import { Truck } from "lucide-react-native";
import { txt } from "@/lib/font";

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  const { startOAuthFlow } = useOAuth({ strategy: "oauth_google" });
  const { signOut } = useAuth();
  const [busy, setBusy] = React.useState(false);

  async function onSignIn() {
    if (busy) return;
    setBusy(true);
    try {
      // Clear any stale session before launching OAuth. The Clerk
      // Expo SDK occasionally lands in a state where useAuth() reads
      // isSignedIn:false (so the root layout sends the user here)
      // while startOAuthFlow() still detects a leftover session token
      // and rejects with "already signed in". Most often hit when
      // switching accounts on a shared device. Signing out first
      // guarantees a clean slate; if there's nothing to sign out
      // from, the call is a no-op.
      try { await signOut(); } catch { /* no active session — fine */ }
      const { createdSessionId, setActive } = await startOAuthFlow();
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
      }
    } catch (err) {
      Alert.alert("Sign in failed", err instanceof Error ? err.message : "Try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 }}>
        <View style={{
          width: 88, height: 88, borderRadius: 22,
          backgroundColor: "rgba(255,255,255,0.16)",
          alignItems: "center", justifyContent: "center",
          marginBottom: 22,
        }}>
          <Truck size={44} color="#ffffff" strokeWidth={2.2} />
        </View>
        <Text style={[txt(800), { fontSize: 30, color: "#ffffff", letterSpacing: -0.5 }]}>
          FleetCal Go
        </Text>
        <Text style={[txt(500), { fontSize: 14, color: "rgba(255,255,255,0.7)", marginTop: 8, textAlign: "center" }]}>
          Sign in with your Google account to view today&apos;s schedule.
        </Text>

        <TouchableOpacity
          onPress={onSignIn}
          activeOpacity={0.85}
          disabled={busy}
          style={{
            marginTop: 36,
            backgroundColor: "#ffffff",
            borderRadius: 14,
            paddingVertical: 16,
            paddingHorizontal: 28,
            alignItems: "center",
            minWidth: 240,
            shadowColor: "#000",
            shadowOpacity: 0.18,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
          }}
        >
          {busy ? (
            <ActivityIndicator color="#1a73e8" />
          ) : (
            <Text style={[txt(800), { fontSize: 15, color: "#1a73e8", letterSpacing: 0.3 }]}>
              Continue with Google
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
