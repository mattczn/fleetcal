import React from "react";
import { Stack } from "expo-router";

/**
 * The signed-in app is a Stack so that pushing into a load detail (or
 * profile / new-load / trash) layers on top of whichever tab the user
 * was on, and `router.back()` returns there with state preserved.
 * The bottom tab bar lives inside the `(tabs)` group as the root
 * screen of this stack.
 */
export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="new-load" />
      <Stack.Screen name="load/[id]" />
      <Stack.Screen name="trash" />
    </Stack>
  );
}
