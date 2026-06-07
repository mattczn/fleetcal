import React from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { ClerkProvider, useAuth, useClerk } from "@clerk/clerk-expo";
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
 * Bypass switch — when the Clerk SDK hangs on init and we can't
 * see why, this lets the user force-render the rest of the tree
 * so they can at least try to navigate to sign-in manually.
 *
 * Stored as BOTH a module ref (so non-React code like AuthGate's
 * effect can read it synchronously) AND a useState pair lifted
 * into ClerkGate (so React knows to re-render when it flips).
 * The earlier version only flipped the ref, which is why tapping
 * the button did nothing — ClerkGate never re-rendered.
 * ============================================================ */
const bypassRef = { current: false };

function Splash({ status, detail, showProbe, onBypass }: { status: string; detail?: string; showProbe?: boolean; onBypass?: () => void }) {
  const [showHelp, setShowHelp] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [probe, setProbe] = React.useState<string>("not run");

  // Tick the elapsed counter every 500ms.
  React.useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - start), 500);
    return () => clearInterval(t);
  }, []);

  // After 6 seconds reveal the help panel.
  React.useEffect(() => {
    const t = setTimeout(() => setShowHelp(true), 6000);
    return () => clearTimeout(t);
  }, []);

  // Reach behind the SDK and confirm WE can hit Clerk's frontend
  // directly. If this succeeds while useAuth().isLoaded never
  // flips, the SDK is broken (not the network). If it fails, the
  // device can't reach Clerk at all.
  React.useEffect(() => {
    if (!showProbe) return;
    const start = Date.now();
    // Probe /v1/client with the EXACT native-API markers the SDK
    // uses (_is_native=1 + x-mobile: 1). If Clerk's prod backend
    // rejects, the response body will tell us exactly which error
    // code (native_api_disabled, origin_invalid, etc.) — that's
    // the smoking gun the SDK is hiding behind retry/backoff.
    const url = `https://clerk.fleetcal.app/v1/client?_clerk_js_version=5.125.10&_is_native=1`;
    fetch(url, {
      method: "GET",
      headers: {
        "x-mobile": "1",
        "authorization": "",
        "content-type": "application/x-www-form-urlencoded",
      },
    })
      .then(async r => {
        const body = await r.text();
        // Pull out the error code if it's a Clerk error response.
        let code = "?";
        try {
          const j = JSON.parse(body);
          code = j?.errors?.[0]?.code ?? "no-errors-key";
        } catch { code = "parse-fail"; }
        setProbe(`${r.status} ${code} ${Date.now() - start}ms | ${body.slice(0, 200)}`);
      })
      .catch(e => setProbe(`FAIL ${(e as Error).message}`));
  }, [showProbe]);

  // Try to read Clerk's internal state — gives us the boolean we
  // see (useAuth.isLoaded) PLUS the underlying client/session ids
  // when they exist. Surface non-fatally; if useClerk throws (no
  // provider) we just show "no clerk".
  let clerkState = "no clerk";
  try {
    const clerk = useClerk();
    const clientId = clerk?.client?.id ?? "—";
    const sessionId = clerk?.session?.id ?? "—";
    clerkState = `loaded=${clerk?.loaded} client=${clientId.slice(0, 16)} session=${sessionId.slice(0, 16)}`;
  } catch { /* outside ClerkProvider */ }

  const clearAndRetry = async () => {
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
    setShowHelp(false);
  };

  const bypassClerk = () => {
    bypassRef.current = true;
    onBypass?.();
  };

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#1a73e8", padding: 24 }}>
      <ActivityIndicator color="#ffffff" size="large" />
      <Text style={{ color: "#ffffff", marginTop: 16, fontSize: 16, fontWeight: "600" }}>{status}</Text>
      {detail ? (
        <Text style={{ color: "#dbeafe", marginTop: 4, fontSize: 12 }}>{detail}</Text>
      ) : null}
      <Text style={{ color: "#bfdbfe", marginTop: 12, fontSize: 11, fontVariant: ["tabular-nums"] }}>
        {(elapsed / 1000).toFixed(1)}s elapsed
      </Text>
      {showHelp ? (
        <ScrollView style={{ marginTop: 20, maxHeight: 480, width: "100%" }} contentContainerStyle={{ paddingBottom: 24 }}>
          <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "700", marginBottom: 8 }}>
            Diagnostic
          </Text>
          <Text style={{ color: "#dbeafe", fontSize: 11, marginBottom: 4 }}>
            pk: {env.clerkPublishableKey.slice(0, 24)}…
          </Text>
          <Text style={{ color: "#dbeafe", fontSize: 11, marginBottom: 4 }}>
            api: {env.railwayApiUrl ?? "unset"}
          </Text>
          <Text style={{ color: "#dbeafe", fontSize: 11, marginBottom: 4 }}>
            clerk: {clerkState}
          </Text>
          <Text style={{ color: "#dbeafe", fontSize: 11, marginBottom: 16 }}>
            probe: {probe}
          </Text>
          <Pressable
            onPress={clearAndRetry}
            style={{ backgroundColor: "#ffffff", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: "center", marginBottom: 8 }}>
            <Text style={{ color: "#1a73e8", fontWeight: "700" }}>Clear cached session</Text>
          </Pressable>
          <Pressable
            onPress={bypassClerk}
            style={{ backgroundColor: "#fbbf24", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: "center" }}>
            <Text style={{ color: "#78350f", fontWeight: "700" }}>Continue without auth</Text>
          </Pressable>
          <Text style={{ color: "#dbeafe", fontSize: 10, marginTop: 8, textAlign: "center" }}>
            Bypasses Clerk init — sends you to sign-in screen where you can sign in manually
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

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

function ClerkGate({ children }: { children: React.ReactNode }) {
  const { isLoaded } = useAuth();
  const [bypass, setBypass] = React.useState(false);
  if (!isLoaded && !bypass) {
    return <Splash status="Signing you in…" detail="Loading Clerk" showProbe onBypass={() => setBypass(true)} />;
  }
  return <>{children}</>;
}

function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  React.useEffect(() => {
    // If we bypassed Clerk, treat as signed-out and route to sign-in.
    const effectiveLoaded = isLoaded || bypassRef.current;
    if (!effectiveLoaded) return;
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
          {/* DIAGNOSTIC: tokenCache temporarily disabled to test
              whether SecureStore interaction is what's hanging the
              SDK init. Without a tokenCache the user just gets
              signed out on each app launch — fine for diagnosis,
              not for production. If Clerk loads with this, we know
              the bug is in tokenCache <-> Clerk SDK. */}
          <ClerkProvider publishableKey={env.clerkPublishableKey}>
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
