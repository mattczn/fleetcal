/**
 * Stop instructions widget — collapsed to 2 lines by default with a
 * "Show more" / "Show less" toggle. Long broker notes (gate codes,
 * appointment requirements, paperwork, etc.) get cut off cleanly until
 * the driver taps in.
 *
 * When collapsed: a `<Text>` with `numberOfLines={2}` ellipsizes.
 * When expanded:  a `<TextInput>` so the driver can copy / select.
 */
import React, { useState } from "react";
import { View, Text, TouchableOpacity, TextInput, type TextStyle } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

export interface ExpandableInstructionsProps {
  value:    string;
  /** Body text style — color, fontSize, lineHeight, etc. */
  textStyle: TextStyle;
  /** Toggle pill color. Defaults to a neutral gray. */
  toggleColor?: string;
}

export function ExpandableInstructions({
  value, textStyle, toggleColor = "#5f6368",
}: ExpandableInstructionsProps) {
  const [expanded, setExpanded] = useState(false);
  // Heuristic — only show the toggle when the text is plausibly more
  // than two lines. ~50 chars/line on a phone, so > 100 chars is a
  // safe trigger. This avoids a useless "Show more" on short notes.
  const longEnoughToToggle = value.length > 100 || value.includes("\n");

  return (
    <View style={{ flex: 1 }}>
      {expanded ? (
        <TextInput
          value={value}
          editable={false}
          multiline
          scrollEnabled={false}
          style={[{ padding: 0, margin: 0, includeFontPadding: false } as object, textStyle]}
        />
      ) : (
        <Text numberOfLines={2} style={textStyle}>
          {value}
        </Text>
      )}
      {longEnoughToToggle ? (
        <TouchableOpacity
          onPress={() => setExpanded((e) => !e)}
          hitSlop={6}
          activeOpacity={0.7}
          style={{ flexDirection: "row", alignItems: "center", gap: 3, marginTop: 6, alignSelf: "flex-start" }}
        >
          <Text style={[txt(800), { fontSize: 11, color: toggleColor, letterSpacing: 0.3 }]}>
            {expanded ? "Show less" : "Show more"}
          </Text>
          {expanded
            ? <ChevronUp   size={12} color={toggleColor} strokeWidth={2.6} />
            : <ChevronDown size={12} color={toggleColor} strokeWidth={2.6} />}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
