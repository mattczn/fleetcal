/**
 * Frosted surface — the design's "liquid glass" header / tab bar / status dock.
 *
 * Rendered as a near-opaque translucent panel (with a hairline top highlight +
 * shadow) rather than a real backdrop blur, so it stays OTA-safe (no native
 * `expo-blur`). The fill/shadow flip with the active theme.
 *
 * Outer view carries radius + shadow; an absolutely-filled inner view carries
 * the translucent fill (clipped to the radii) — shadows can't render through
 * `overflow: hidden`, so they're separate layers.
 */
import React from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";
import { useTheme } from "@/lib/ThemeProvider";

type Props = {
  children?: React.ReactNode;
  /** Outer style — position, padding, and the corner radii live here. */
  style?: ViewStyle | ViewStyle[];
  /** Corner radii, applied to both the shadow layer and the fill. */
  radii?: ViewStyle;
  /** `.deep` in the design — a more opaque fill for headers / docks. */
  deep?: boolean;
  /** Drop the glass shadow (e.g. for small inline pills). */
  withShadow?: boolean;
};

export function Glass({ children, style, radii, deep = false, withShadow = true }: Props) {
  const { SHADOW, glassFill, glassFillDeep, glassHair } = useTheme();
  return (
    <View style={[withShadow && SHADOW.glass, radii, style]}>
      <View
        style={[
          StyleSheet.absoluteFill,
          radii,
          { backgroundColor: deep ? glassFillDeep : glassFill, overflow: "hidden" },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          radii,
          { borderTopWidth: StyleSheet.hairlineWidth, borderColor: glassHair },
        ]}
      />
      {children}
    </View>
  );
}
