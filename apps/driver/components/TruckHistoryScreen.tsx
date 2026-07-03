/**
 * TruckHistoryScreen — the Curzon-only "Truck History" module surface,
 * opened from the "View truck history" button on the driver's load
 * detail (and from wherever a truck/trailer needs its history shown).
 *
 * Calls railway.getEquipmentHistory(kind, id) and renders the history
 * body — four sections + swipeable photo viewer — via the shared
 * <EquipmentHistoryCards>. The same component backs the new inspection
 * Step 1 (select asset + review history), so there's one implementation.
 *
 * When the load also has a trailer, the caller can pass `trailer` and the
 * screen shows an asset/trailer toggle at the top.
 *
 * The endpoint 404s when the module is off — we surface a friendly
 * "not available" state rather than an error in that case.
 */
import React, { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { ArrowLeft, Truck, Container, AlertTriangle } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { railway } from "@/lib/railway";
import { useTheme } from "@/lib/ThemeProvider";
import EquipmentHistoryCards from "@/components/EquipmentHistoryCards";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium" :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold" :
                     "PlusJakartaSans_800ExtraBold",
});

interface EquipRef { kind: "asset" | "trailer"; id: number; label: string }

interface Props {
  /** The truck to show first. */
  asset: EquipRef;
  /** Optional trailer — when present the screen offers an asset/trailer
   *  toggle so the driver can flip between the two histories. */
  trailer?: EquipRef | null;
  onClose: () => void;
}

export default function TruckHistoryScreen({ asset, trailer, onClose }: Props) {
  const { C, ACCENT } = useTheme();
  const [tab, setTab] = useState<EquipRef>(asset);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["equipment-history", tab.kind, tab.id],
    queryFn:  () => railway.getEquipmentHistory(tab.kind, tab.id),
  });

  // A 404 means the module is off for this org — treat it as an
  // "unavailable" state, not a hard error.
  const notAvailable = isError && /404|not found/i.test(String((error as Error)?.message ?? ""));

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface }}>
        <TouchableOpacity onPress={onClose} style={{ padding: 6, marginLeft: -6 }}>
          <ArrowLeft size={22} color={C.t1} />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 17, color: C.t1 }]}>Truck history</Text>
      </View>

      {/* Asset / trailer toggle — only when a trailer is available. */}
      {trailer && (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}>
          <ToggleChip
            icon={<Truck size={14} color={tab.kind === "asset" ? "#fff" : C.t2} />}
            label={asset.label}
            active={tab.kind === "asset"}
            onPress={() => setTab(asset)}
          />
          <ToggleChip
            icon={<Container size={14} color={tab.kind === "trailer" ? "#fff" : C.t2} />}
            label={trailer.label}
            active={tab.kind === "trailer"}
            onPress={() => setTab(trailer)}
          />
        </View>
      )}

      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : notAvailable ? (
        <CenteredNote title="Not available" subtitle="Truck history isn't enabled for this fleet." />
      ) : isError ? (
        <CenteredNote title="Couldn't load history" subtitle="Pull back and try again." />
      ) : data ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
          <EquipmentHistoryCards data={data} />
        </ScrollView>
      ) : null}
    </View>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────

function ToggleChip({ icon, label, active, onPress }: { icon: React.ReactNode; label: string; active: boolean; onPress: () => void }) {
  const { C, ACCENT } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row", alignItems: "center", gap: 6,
        paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
        backgroundColor: active ? ACCENT : C.surface2,
        borderWidth: 1, borderColor: active ? ACCENT : C.border,
      }}
    >
      {icon}
      <Text style={[txt(700), { fontSize: 13, color: active ? "#fff" : C.t2 }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function CenteredNote({ title, subtitle }: { title: string; subtitle: string }) {
  const { C } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
      <AlertTriangle size={28} color={C.t4} />
      <Text style={[txt(700), { fontSize: 16, color: C.t2 }]}>{title}</Text>
      <Text style={[txt(500), { fontSize: 13, color: C.t4, textAlign: "center" }]}>{subtitle}</Text>
    </View>
  );
}
