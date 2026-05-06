import React, { useEffect } from "react";
import { View, ActivityIndicator } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useFonts,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { useDriverSession, type DriverSessionState } from "@/lib/useDriverSession";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 2,
    },
  },
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
    <QueryClientProvider client={queryClient}>
      <RootLayoutInner />
    </QueryClientProvider>
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
