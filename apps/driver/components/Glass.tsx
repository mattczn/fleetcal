/**
 * Liquid-glass surface — the design's frosted header / tab bar / status dock.
 *
 * CSS used `backdrop-filter: blur()` + a translucent white fill + an inner
 * hairline highlight. We reproduce that with `expo-blur`'s BlurView plus a
 * translucent overlay (so it still reads as frosted on Android, where blur
 * is weaker) and a 1px top highlight.
 *
 * The blur is clipped by an absolutely-filled inner view (overflow hidden),
 * while the outer view carries the radius + shadow — shadows can't render
 * through `overflow: hidden`, so the two have to be separate layers.
 */
import React from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { SHADOW } from "@/lib/theme";

type Props = {
  children?: React.ReactNode;
  /** Outer style — position, padding, and the corner radii live here. */
  style?: ViewStyle | ViewStyle[];
  /** Corner radii, applied to both the shadow layer and the blur clip. */
  radii?: ViewStyle;
  /** `.deep` in the design — a more opaque fill for headers/docks. */
  deep?: boolean;
  /** Drop the glass shadow (e.g. for small inline pills). */
  withShadow?: boolean;
};

export function Glass({ children, style, radii, deep = false, withShadow = true }: Props) {
  return (
    <View style={[withShadow && SHADOW.glass, radii, style]}>
      {/* clipped frosted backdrop */}
      <View style={[StyleSheet.absoluteFill, radii, { overflow: "hidden" }]}>
        <BlurView intensity={deep ? 42 : 26} tint="light" style={StyleSheet.absoluteFill} />
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: deep ? "rgba(255,255,255,0.66)" : "rgba(255,255,255,0.55)" },
          ]}
        />
      </View>
      {/* inner hairline highlight + edge */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          radii,
          { borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.85)" },
        ]}
      />
      {children}
    </View>
  );
}
