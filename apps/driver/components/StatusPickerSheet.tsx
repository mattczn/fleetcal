import React from "react";
import { Modal, View, Text, TouchableOpacity, Pressable } from "react-native";
import { Check, X } from "lucide-react-native";
import type { LoadStatus } from "@/lib/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

// Every LoadStatus must have a row — Record<LoadStatus, …> enforces
// this at compile time. Skipping a status (e.g. `assigned` was added
// to the union but never added here for a stretch) means the picker
// renders undefined.label / undefined.bg and the whole sheet crashes.
// Same root-cause class as the load detail's STOP_ACCENT bug.
const STATUS_META: Record<LoadStatus, { label: string; bg: string; fg: string; group: "progress" | "exception" }> = {
  scheduled:  { label: "Scheduled",  bg: "#f1f3f4", fg: "#5f6368", group: "progress"  },
  assigned:   { label: "Assigned",   bg: "#e0f2fe", fg: "#075985", group: "progress"  },
  dispatched: { label: "Dispatched", bg: "#e8f0fe", fg: "#1558d6", group: "progress"  },
  en_route:   { label: "En Route",   bg: "#fef3c7", fg: "#92400e", group: "progress"  },
  picked_up:  { label: "Picked Up",  bg: "#f3e8fd", fg: "#6b21a8", group: "progress"  },
  delivered:  { label: "Delivered",  bg: "#e6f4ea", fg: "#15803d", group: "progress"  },
  cancelled:  { label: "Cancelled",  bg: "#fce8e6", fg: "#b91c1c", group: "exception" },
  tonu:       { label: "TONU",       bg: "#fef3c7", fg: "#92400e", group: "exception" },
  problem:    { label: "Problem",    bg: "#fef0e6", fg: "#b85c00", group: "exception" },
};

const PROGRESS_ORDER: LoadStatus[] = ["scheduled", "assigned", "dispatched", "en_route", "picked_up", "delivered"];
const EXCEPTION_ORDER: LoadStatus[] = ["problem"];

type Props = {
  visible: boolean;
  current: LoadStatus;
  onClose:  () => void;
  onSelect: (s: LoadStatus) => void;
};

export function StatusPickerSheet({ visible, current, onClose, onSelect }: Props) {
  function StatusRow({ status }: { status: LoadStatus }) {
    const m = STATUS_META[status];
    const isCurrent = status === current;
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => onSelect(status)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 14,
          paddingHorizontal: 18,
        }}
      >
        <View
          style={{
            paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
            backgroundColor: m.bg,
          }}
        >
          <Text style={[txt(700), { fontSize: 11, color: m.fg, letterSpacing: 0.2 }]}>
            {m.label}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        {isCurrent ? <Check size={18} color="#1a73e8" strokeWidth={2.6} /> : null}
      </TouchableOpacity>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingBottom: 28,
            paddingTop: 8,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 18,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: "#f1f3f4",
            }}
          >
            <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
              Update load status
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <Text
            style={[
              txt(800),
              {
                fontSize: 11,
                letterSpacing: 1,
                color: "#5f6368",
                paddingHorizontal: 18,
                paddingTop: 14,
                paddingBottom: 4,
                textTransform: "uppercase",
              },
            ]}
          >
            Progress
          </Text>
          {PROGRESS_ORDER.map((s) => <StatusRow key={s} status={s} />)}

          <Text
            style={[
              txt(800),
              {
                fontSize: 11,
                letterSpacing: 1,
                color: "#5f6368",
                paddingHorizontal: 18,
                paddingTop: 14,
                paddingBottom: 4,
                textTransform: "uppercase",
              },
            ]}
          >
            Exceptions
          </Text>
          {EXCEPTION_ORDER.map((s) => <StatusRow key={s} status={s} />)}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
