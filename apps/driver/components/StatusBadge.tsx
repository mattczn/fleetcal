import React from "react";
import { View, Text } from "react-native";
import { AlertCircle } from "lucide-react-native";
import type { LoadStatus } from "@/lib/types";
import { STATUS_LABEL } from "@/lib/loadCard";
import { useTheme } from "@/lib/ThemeProvider";

/**
 * Always-visible status pill used on the load-detail screen. Distinct
 * from the smaller `StatusPill` in lib/loadCard (which hides on the
 * "scheduled" default) — this one renders for every status because the
 * load detail's source-of-truth slot can't be empty. When needsAction
 * is set we swap to a red "Confirm" CTA so the driver sees it on entry.
 */
export function StatusBadge({
  status,
  needsAction,
}: {
  status: LoadStatus;
  needsAction?: boolean;
}) {
  const { C, STATUS_PILL } = useTheme();
  const ACTION_TINT = { bg: C.red, fg: "#ffffff" };
  const tint  = needsAction ? ACTION_TINT : (STATUS_PILL[status] ?? STATUS_PILL.scheduled);
  const label = needsAction ? "Confirm"   : (STATUS_LABEL[status] ?? STATUS_LABEL.scheduled);
  return (
    <View
      style={{
        flexDirection:      "row",
        alignItems:         "center",
        gap:                4,
        paddingHorizontal:  needsAction ? 8 : 10,
        paddingVertical:    4,
        borderRadius:       999,
        backgroundColor:    tint.bg,
      }}
    >
      {needsAction ? <AlertCircle size={11} color={tint.fg} strokeWidth={2.6} /> : null}
      <Text
        style={{
          fontFamily:    "PlusJakartaSans_700Bold",
          fontSize:      11,
          letterSpacing: 0.3,
          color:         tint.fg,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
