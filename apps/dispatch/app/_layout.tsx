import React from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { ClerkProvider, useAuth } from "@clerk/clerk-expo";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { View, Text, ActivityIndicator, Pressable, ScrollView } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  useFonts,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { tokenCache } from "@/lib/tokenCache";
import { env } from "@/lib/env";
import { queryClient, persister, PERSIST_MAX_AGE } from "@/lib/queryClient";
import RailwayClientProvider from "@/components/RailwayClientProvider";
import CachePrefetcher from "@/components/CachePrefetcher";
import OfflineBanner from "@/components/OfflineBanner";
import RealtimeSync from "@/components/RealtimeSync";

/* ============================================================
 * Splash overlay — visible loading state.
 *
 * The old _layout used <ClerkLoaded>, which renders NOTHING while
 * Clerk is initializing. Combined with the blue native splash, that
 * meant any Clerk hang (bad publishable key, persisted dev token
 * against a prod instance, network block) produced a featureless
 * blue screen with no way to diagnose. We now always render a
 * spinner + status label so the user can SEE what state we're in,
 * and after 8 seconds we surface enough debug info to know whether
 * the issue is fonts, Clerk init, or the token cache.
 * ============================================================ */
function Splash({ status, detail }: { status: string; detail?: string }) {
  const [showHelp, setShowHelp] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setShowHelp(true), 8000);
    return () => clearTimeout(t);
  }, []);
  const clearAndRetry = async () => {
    // Best-effort wipe of every SecureStore key Clerk might own.
    // SecureStore has no "list keys" API on iOS, so we delete by
    // the known Clerk key names under both the new (prefixed) and
    // legacy (unprefixed) namespaces. Anything we miss is harmless
    // — it just sits in the keychain unused.
    const candidates = [
      "__clerk_client_jwt",
      "__clerk_session_jwt",
      "__clerk_handshake",
      "__clerk_db_jwt",
    ];
    const prefix = env.clerkPublishableKey.slice(0, 16);
    for (const k of candidates) {
      try { await SecureStore.deleteItemAsync(k); } catch {}
      try { await SecureStore.deleteItemAsync(`${prefix}__${k}`); } catch {}
    }
    // Restart the app surface by re-mounting at root.
    // (User-facing version: tell them to force-quit and reopen.)
    setShowHelp(false);
  };
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#1a73e8", padding: 24 }}>
      <ActivityIndicator color="#ffffff" size="large" />
      <Text style={{ color: "#ffffff", marginTop: 16, fontSize: 16, fontWeight: "600" }}>{status}</Text>
      {detail ? (
        <Text style={{ color: "#dbeafe", marginTop: 4, fontSize: 12 }}>{detail}</Text>
      ) : null}
      {showHelp ? (
        <ScrollView style={{ marginTop: 24, maxHeight: 240, width: "100%" }}>
          <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "700", marginBottom: 8 }}>
            Still loading after 8s.
          </Text>
          <Text style={{ color: "#dbeafe", fontSize: 11, marginBottom: 4 }}>
            pk: {env.clerkPublishableKey.slice(0, 24)}…
          </Text>
          <Text style={{ color: "#dbeafe", fontSize: 11, marginBottom: 16 }}>
            api: {env.railwayApiUrl ?? "unset"}
          </Text>
          <Pressable
            onPress={clearAndRetry}
            style={{ backgroundColor: "#ffffff", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: "center" }}>
            <Text style={{ color: "#1a73e8", fontWeight: "700" }}>Clear cached session</Text>
          </Pressable>
          <Text style={{ color: "#dbeafe", fontSize: 10, marginTop: 8, textAlign: "center" }}>
            Then force-quit the app (swipe up) and reopen.
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

/* ============================================================
 * Error boundary — catches anything thrown during render so we
 * never render literally nothing. Without this, a thrown error
 * in the provider tree leaves the user staring at the native
 * blue splash forever.
 * ============================================================ */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[RootErrorBoundary]", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#1a73e8", padding: 24 }}>
          <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "700", marginBottom: 12 }}>
            App failed to start
          </Text>
          <ScrollView style={{ maxHeight: 280 }}>
            <Text style={{ color: "#dbeafe", fontSize: 12, fontFamily: "Menlo" }}>
              {this.state.error.name}: {this.state.error.message}
            </Text>
            {this.state.error.stack ? (
              <Text style={{ color: "#bfdbfe", fontSize: 10, fontFamily: "Menlo", marginTop: 12 }}>
                {this.state.error.stack}
              </Text>
            ) : null}
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

/* ============================================================
 * ClerkGate — replaces <ClerkLoaded>. When isLoaded is false we
 * show the Splash with a meaningful status label; once Clerk is
 * loaded we render the rest of the tree.
 * ============================================================ */
function ClerkGate({ children }: { children: React.ReactNode }) {
  const { isLoaded } = useAuth();
  if (!isLoaded) {
    return <Splash status="Signing you in…" detail="Loading Clerk" />;
  }
  return <>{children}</>;
}

function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoaded) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (isSignedIn && inAuthGroup) {
      router.replace("/");
    } else if (!isSignedIn && !inAuthGroup) {
      router.replace("/(auth)/sign-in");
    }
  }, [isLoaded, isSignedIn, segments, router]);

  return <Slot />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  if (!fontsLoaded) {
    return <Splash status="Loading fonts…" />;
  }

  return (
    <RootErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ClerkProvider tokenCache={tokenCache} publishableKey={env.clerkPublishableKey}>
            <ClerkGate>
              <RailwayClientProvider>
                <PersistQueryClientProvider
                  client={queryClient}
                  persistOptions={{ persister, maxAge: PERSIST_MAX_AGE }}
                >
                  <CachePrefetcher />
                  <RealtimeSync />
                  <StatusBar style="light" />
                  <AuthGate />
                  <OfflineBanner />
                </PersistQueryClientProvider>
              </RailwayClientProvider>
            </ClerkGate>
          </ClerkProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </RootErrorBoundary>
  );
}
