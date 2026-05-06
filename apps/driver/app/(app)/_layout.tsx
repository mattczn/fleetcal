import React from "react";
import { Stack } from "expo-router";

/**
 * The signed-in driver app is a Stack so that pushing into a load
 * detail or upload screen layers on top of whichever tab the driver
 * was on, and `router.back()` returns there with state preserved.
 * The bottom tab bar lives inside the `(tabs)` group as the root
 * screen of this stack.
 */
export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="load/[id]" />
      <Stack.Screen name="upload/[id]" />
    </Stack>
  );
}
