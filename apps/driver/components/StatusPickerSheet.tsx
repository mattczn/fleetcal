import React from "react";
import { Modal, View, Text, TouchableOpacity, Pressable } from "react-native";
import { Check, X } from "lucide-react-native";
import type { LoadStatus } from "@/lib/types";
import { useTheme } from "@/lib/ThemeProvider";

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
function statusMeta(C: ReturnType<typeof useTheme>["C"]): Record<LoadStatus, { label: string; bg: string; fg: string; group: "progress" | "exception" }> {
  return {
    scheduled:  { label: "Scheduled",  bg: C.borderSoft, fg: C.t3,        group: "progress"  },
    assigned:   { label: "Assigned",   bg: C.blueBg,     fg: C.blueInk,    group: "progress"  },
    dispatched: { label: "Dispatched", bg: C.blueBg,     fg: C.blueInk,    group: "progress"  },
    en_route:   { label: "En Route",   bg: C.amberBg,    fg: C.amberInk,   group: "progress"  },
    picked_up:  { label: "Picked Up",  bg: C.purpleBg,   fg: C.purpleInk,  group: "progress"  },
    delivered:  { label: "Delivered",  bg: C.greenBg,    fg: C.greenInk,   group: "progress"  },
    cancelled:  { label: "Cancelled",  bg: C.redBg,      fg: C.redInk,     group: "exception" },
    tonu:       { label: "TONU",       bg: C.amberBg,    fg: C.amberInk,   group: "exception" },
    problem:    { label: "Problem",    bg: C.amberBg,    fg: C.amberInk,   group: "exception" },
  };
}

const PROGRESS_ORDER: LoadStatus[] = ["scheduled", "assigned", "dispatched", "en_route", "picked_up", "delivered"];
const EXCEPTION_ORDER: LoadStatus[] = ["problem"];

type Props = {
  visible: boolean;
  current: LoadStatus;
  onClose:  () => void;
  onSelect: (s: LoadStatus) => void;
};

export function StatusPickerSheet({ visible, current, onClose, onSelect }: Props) {
  const { C, SHADOW, ACCENT } = useTheme();
  const STATUS_META = statusMeta(C);
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
        {isCurrent ? <Check size={18} color={ACCENT} strokeWidth={2.6} /> : null}
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
            backgroundColor: C.surface,
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
              borderBottomColor: C.borderSoft,
            }}
          >
            <Text style={[txt(800), { fontSize: 16, color: C.t1, flex: 1 }]}>
              Update load status
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color={C.t3} strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <Text
            style={[
              txt(800),
              {
                fontSize: 11,
                letterSpacing: 1,
                color: C.t3,
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
                color: C.t3,
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
