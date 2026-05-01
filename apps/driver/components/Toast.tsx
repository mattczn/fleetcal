import React, { useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";
import { Check } from "lucide-react-native";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

type Props = {
  message: string | null;
  bottom?: number;
};

/**
 * Tiny snackbar. Pass a non-null `message` to trigger; it fades in,
 * then the parent should clear it after the delay (so a different
 * message can re-trigger immediately).
 */
export function Toast({ message, bottom = 100 }: Props) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (message) {
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    } else {
      Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }).start();
    }
  }, [message, opacity]);

  if (!message) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0, right: 0, bottom,
        alignItems: "center",
        opacity,
        zIndex: 50,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: "#202124",
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 999,
          shadowColor: "#000",
          shadowOpacity: 0.25,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
        }}
      >
        <Check size={14} color="#86efac" strokeWidth={2.6} />
        <Text style={[txt(700), { fontSize: 13, color: "#ffffff", letterSpacing: 0.2 }]}>
          {message}
        </Text>
      </View>
    </Animated.View>
  );
}
