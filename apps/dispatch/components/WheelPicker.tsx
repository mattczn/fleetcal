import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated, View, Text, ScrollView,
  type NativeSyntheticEvent, type NativeScrollEvent,
} from "react-native";
import { txt } from "@/lib/font";

interface Props<T extends string | number> {
  items: T[];
  value: T;
  onChange: (next: T) => void;
  width?: number;
  itemHeight?: number;
  /** Visible rows — must be odd. Default 5. */
  visibleCount?: number;
  format?: (v: T) => string;
}

/**
 * iOS-style scroll wheel. Each row's opacity and scale are interpolated against
 * the live scroll position so items fade and shrink as they leave center —
 * gives the wheel its rounded look without needing a 3D transform.
 *
 * Programmatic value changes (`value` prop differs from current scroll index)
 * trigger an animated scroll. User-driven changes are not echoed back, so the
 * effect doesn't fight an in-flight gesture.
 */
export function WheelPicker<T extends string | number>({
  items, value, onChange, width = 64, itemHeight = 38, visibleCount = 5, format,
}: Props<T>) {
  const VISIBLE = visibleCount % 2 === 0 ? visibleCount + 1 : visibleCount;
  const PAD     = ((VISIBLE - 1) / 2) * itemHeight;
  const HEIGHT  = VISIBLE * itemHeight;

  const scrollY = useRef(new Animated.Value(0)).current;
  const ref     = useRef<ScrollView | null>(null);
  // Last index our onChange emitted — guards against the value-sync effect
  // firing scrollTo while the user is mid-gesture.
  const lastEmittedIdx = useRef<number>(-1);

  const valueIdx = useMemo(() => Math.max(0, items.indexOf(value)), [items, value]);

  // Sync external value → wheel position (skip if it's our own echo).
  useEffect(() => {
    if (valueIdx === lastEmittedIdx.current) return;
    ref.current?.scrollTo({ y: valueIdx * itemHeight, animated: false });
  }, [valueIdx, itemHeight]);

  function onMomentumEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = e.nativeEvent.contentOffset.y;
    const idx = Math.max(0, Math.min(items.length - 1, Math.round(y / itemHeight)));
    if (items[idx] === value) return;
    lastEmittedIdx.current = idx;
    onChange(items[idx]);
  }

  return (
    <View style={{ width, height: HEIGHT, overflow: "hidden" }}>
      {/* Center highlight band — sits behind the centered row. */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute", left: 4, right: 4,
          top: PAD, height: itemHeight,
          borderTopWidth:    1,
          borderBottomWidth: 1,
          borderColor: "rgba(60,64,67,0.15)",
        }}
      />

      <Animated.ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={itemHeight}
        decelerationRate="fast"
        contentOffset={{ x: 0, y: valueIdx * itemHeight }}
        contentContainerStyle={{ paddingTop: PAD, paddingBottom: PAD }}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
        onMomentumScrollEnd={onMomentumEnd}
        style={{ height: HEIGHT }}
      >
        {items.map((it, i) => {
          // Distance from the selected center, in row-units. 0 = focused.
          const inputRange = [
            (i - 2) * itemHeight,
            (i - 1) * itemHeight,
            i       * itemHeight,
            (i + 1) * itemHeight,
            (i + 2) * itemHeight,
          ];
          const opacity = scrollY.interpolate({
            inputRange,
            outputRange: [0.18, 0.45, 1, 0.45, 0.18],
            extrapolate: "clamp",
          });
          const scale = scrollY.interpolate({
            inputRange,
            outputRange: [0.78, 0.9, 1.0, 0.9, 0.78],
            extrapolate: "clamp",
          });
          return (
            <Animated.View
              key={`${i}-${it}`}
              style={{
                height: itemHeight,
                alignItems: "center",
                justifyContent: "center",
                opacity,
                transform: [{ scale }],
              }}
            >
              <Text
                style={[
                  txt(700),
                  {
                    fontSize: 20,
                    color: "#202124",
                    letterSpacing: 0.4,
                  },
                ]}
              >
                {format ? format(it) : String(it)}
              </Text>
            </Animated.View>
          );
        })}
      </Animated.ScrollView>

    </View>
  );
}
