import React from "react";
import { View, Text } from "react-native";
import { AlertCircle } from "lucide-react-native";
import type { LoadStatus } from "@/lib/types";

const STATUS_CONFIG: Record<
  LoadStatus,
  { label: string; bg: string; fg: string }
> = {
  scheduled:  { label: "Scheduled",  bg: "#f1f3f4", fg: "#5f6368" },
  dispatched: { label: "Dispatched", bg: "#e8f0fe", fg: "#1558d6" },
  en_route:   { label: "En Route",   bg: "#fef3c7", fg: "#92400e" },
  picked_up:  { label: "Picked Up",  bg: "#f3e8fd", fg: "#6b21a8" },
  delivered:  { label: "Delivered",  bg: "#e6f4ea", fg: "#15803d" },
  cancelled:  { label: "Cancelled",  bg: "#fce8e6", fg: "#b91c1c" },
  tonu:       { label: "TONU",       bg: "#fef3c7", fg: "#92400e" },
  problem:    { label: "Problem",    bg: "#fef0e6", fg: "#b85c00" },
};

const ACTION_CONFIG = { label: "Confirm", bg: "#dc2626", fg: "#ffffff" };

export function StatusBadge({
  status,
  needsAction,
}: {
  status: LoadStatus;
  needsAction?: boolean;
}) {
  const c = needsAction ? ACTION_CONFIG : (STATUS_CONFIG[status] ?? STATUS_CONFIG.scheduled);
  return (
    <View
      style={{
        flexDirection:      "row",
        alignItems:         "center",
        gap:                4,
        paddingHorizontal:  needsAction ? 8 : 10,
        paddingVertical:     4,
        borderRadius:       999,
        backgroundColor:    c.bg,
      }}
    >
      {needsAction ? <AlertCircle size={11} color={c.fg} strokeWidth={2.6} /> : null}
      <Text
        style={{
          fontFamily:    "PlusJakartaSans_700Bold",
          fontSize:      11,
          letterSpacing: 0.3,
          color:         c.fg,
        }}
      >
        {c.label}
      </Text>
    </View>
  );
}
