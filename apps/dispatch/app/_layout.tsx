import React from "react";
import { Slot, Stack, useRouter, useSegments } from "expo-router";
import { ClerkProvider, ClerkLoaded, useAuth } from "@clerk/clerk-expo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { View, ActivityIndicator } from "react-native";
import {
  useFonts,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { tokenCache } from "@/lib/tokenCache";
import { env } from "@/lib/env";
import RailwayClientProvider from "@/components/RailwayClientProvider";

const queryClient = new QueryClient();

function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoaded) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (isSignedIn && inAuthGroup) {
      router.replace("/(app)");
    } else if (!isSignedIn && !inAuthGroup) {
      router.replace("/(auth)/sign-in");
    }
  }, [isLoaded, isSignedIn, segments, router]);

  if (!isLoaded) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#1a73e8" }}>
        <ActivityIndicator color="#ffffff" />
      </View>
    );
  }
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
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#1a73e8" }}>
        <ActivityIndicator color="#ffffff" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ClerkProvider tokenCache={tokenCache} publishableKey={env.clerkPublishableKey}>
          <ClerkLoaded>
            <RailwayClientProvider>
              <QueryClientProvider client={queryClient}>
                <StatusBar style="light" />
                <AuthGate />
              </QueryClientProvider>
            </RailwayClientProvider>
          </ClerkLoaded>
        </ClerkProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
