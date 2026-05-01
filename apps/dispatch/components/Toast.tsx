import React, { useEffect, useRef } from "react";
import { Animated, Easing, View, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { txt } from "@/lib/font";

export function Toast({ message }: { message: string | null }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (message) {
      Animated.timing(opacity, {
        toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(opacity, {
        toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true,
      }).start();
    }
  }, [message, opacity]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        bottom: insets.bottom + 24,
        left: 0, right: 0,
        alignItems: "center",
        opacity,
      }}
    >
      <View style={{
        backgroundColor: "rgba(32,33,36,0.92)",
        paddingHorizontal: 16, paddingVertical: 10,
        borderRadius: 999,
        shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
      }}>
        <Text style={[txt(700), { color: "#ffffff", fontSize: 13, letterSpacing: 0.2 }]}>
          {message ?? ""}
        </Text>
      </View>
    </Animated.View>
  );
}
