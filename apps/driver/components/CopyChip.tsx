import React, { useState, useRef } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy, Check } from "lucide-react-native";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

type Props = {
  label?: string;
  value: string;
  size?: "sm" | "md";
  tint?: "blue" | "neutral" | "white";
};

export function CopyChip({ label, value, size = "md", tint = "blue" }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handlePress() {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  const palette = {
    blue:    { bg: "#e8f0fe", fg: "#1558d6", border: "#c5d8fd" },
    neutral: { bg: "#f1f3f4", fg: "#3c4043", border: "#dadce0" },
    white:   { bg: "rgba(255,255,255,0.12)", fg: "#ffffff", border: "rgba(255,255,255,0.2)" },
  }[tint];

  const padY = size === "sm" ? 3 : 5;
  const padX = size === "sm" ? 8 : 10;
  const fontSize = size === "sm" ? 11 : 13;
  const iconSize = size === "sm" ? 11 : 13;

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handlePress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: palette.bg,
        borderColor: palette.border,
        borderWidth: 1,
        paddingHorizontal: padX,
        paddingVertical: padY,
        borderRadius: 999,
      }}
    >
      {label ? (
        <Text style={[txt(700), { fontSize: fontSize - 2, color: palette.fg, opacity: 0.7, letterSpacing: 0.3 }]}>
          {label.toUpperCase()}
        </Text>
      ) : null}
      <Text style={[txt(800), { fontSize, color: palette.fg }]}>{value}</Text>
      <View>
        {copied ? (
          <Check size={iconSize} color={palette.fg} strokeWidth={2.6} />
        ) : (
          <Copy size={iconSize} color={palette.fg} strokeWidth={2.2} />
        )}
      </View>
    </TouchableOpacity>
  );
}
