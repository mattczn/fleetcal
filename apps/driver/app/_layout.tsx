import React, { useEffect } from "react";
import { View, ActivityIndicator, AppState, type AppStateStatus } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { focusManager, onlineManager } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import NetInfo from "@react-native-community/netinfo";
import {
  useFonts,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { useDriverSession, type DriverSessionState } from "@/lib/useDriverSession";
import { queryClient, asyncStoragePersister, PERSIST_MAX_AGE } from "@/lib/queryClient";
import { drainQueue } from "@/lib/uploadQueue";

// Drive React Query's online state from NetInfo so paused mutations
// auto-resume the moment the radio comes back. Default behavior in
// React Native is "always online" because there's no `window.online`
// event — without this wiring, a mutation fired in airplane mode
// would attempt the network request, fail, and not retry on its own.
//
// The same listener also drives the document upload queue: any PDFs /
// photos enqueued while offline get drained when NetInfo flips online.
// React Query mutations and the upload queue are intentionally separate
// systems because FormData payloads don't serialize through the React
// Query persister — see lib/uploadQueue.ts for why.
// Drive React Query's focus state from AppState so any query with a
// `refetchInterval` (driver NotificationsBell, truck-location on the
// load screen, etc.) automatically pauses when the app backgrounds
// and resumes — with one immediate refetch — when the driver returns.
// Without this wiring, polling continues at full cadence even while
// the phone is locked, burning Motive quota for no UX benefit.
AppState.addEventListener("change", (state: AppStateStatus) => {
  focusManager.setFocused(state === "active");
});

let lastOnline: boolean | null = null;
onlineManager.setEventListener(setOnline => {
  return NetInfo.addEventListener(state => {
    const reachable = state.isInternetReachable;
    const isOnline = reachable === null ? !!state.isConnected : !!reachable;
    setOnline(isOnline);
    // Only drain on a false→true edge, not on every online tick.
    if (isOnline && lastOnline !== true) {
      void drainQueue(entry => {
        // Refresh the documents list for the load this upload was for,
        // so the freshly-replayed doc appears without a manual pull-down.
        queryClient.invalidateQueries({ queryKey: ["documents", entry.eventId] });
      });
    }
    lastOnline = isOnline;
  });
});

function RootNavigator({ session }: { session: DriverSessionState }) {
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    const inAuth = segments[0] === "(auth)";
    const onLogin = inAuth && segments[1] === "login";
    const onNotFound = inAuth && segments[1] === "not-found";

    if (session.status === "signed-out") {
      if (!onLogin) router.replace("/(auth)/login");
      return;
    }
    if (session.status === "not-found") {
      if (!onNotFound) router.replace("/(auth)/not-found");
      return;
    }
    if (session.status === "matched") {
      if (inAuth) router.replace("/");
      return;
    }
  }, [session.status, segments]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: asyncStoragePersister,
        maxAge:    PERSIST_MAX_AGE,
        // Bump when the cache shape changes (e.g. Load type fields)
        // so old persisted blobs are discarded on next launch.
        buster:    "v1",
      }}
      onSuccess={() => {
        // Resume any mutations that were paused (queued) because the
        // device was offline when they fired. Runs after the persister
        // rehydrates, so check-ins / status updates that the driver
        // submitted in a dead zone replay automatically.
        queryClient.resumePausedMutations();
        // Also try draining the document upload queue once at startup
        // in case the app was relaunched online while items were still
        // pending (i.e. before the NetInfo edge listener fires).
        void drainQueue(entry => {
          queryClient.invalidateQueries({ queryKey: ["documents", entry.eventId] });
        });
      }}
    >
      <RootLayoutInner />
    </PersistQueryClientProvider>
  );
}

function RootLayoutInner() {
  const session = useDriverSession();
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  if (!fontsLoaded || session.status === "loading" || session.status === "loading-driver") {
    return (
      <View className="flex-1 bg-brand-navy items-center justify-center">
        <ActivityIndicator color="#1a73e8" />
      </View>
    );
  }

  return <RootNavigator session={session} />;
}
