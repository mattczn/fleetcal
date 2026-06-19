/**
 * Frosted surface — the design's "liquid glass" header / tab bar / status dock.
 *
 * We render it as a near-opaque translucent white panel (with a hairline top
 * highlight + shadow) rather than a real `backdrop-filter` blur. In this
 * layout the glass panels sit over the solid light background (the header is
 * in-flow, the tab bar reserves its tray, the dock floats over a light list),
 * so an actual blur adds almost nothing visible — and avoiding the native
 * `expo-blur` module keeps the whole redesign shippable over-the-air (OTA),
 * not gated behind a native rebuild.
 *
 * Outer view carries radius + shadow; an absolutely-filled inner view carries
 * the translucent fill (clipped to the radii). Shadows can't render through
 * `overflow: hidden`, which is why they're separate layers.
 */
import React from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";
import { SHADOW } from "@/lib/theme";

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
  return (
    <View style={[withShadow && SHADOW.glass, radii, style]}>
      {/* translucent frosted fill, clipped to the radii */}
      <View
        style={[
          StyleSheet.absoluteFill,
          radii,
          { backgroundColor: deep ? "rgba(255,255,255,0.94)" : "rgba(255,255,255,0.85)", overflow: "hidden" },
        ]}
      />
      {/* inner hairline highlight */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          radii,
          { borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.9)" },
        ]}
      />
      {children}
    </View>
  );
}
