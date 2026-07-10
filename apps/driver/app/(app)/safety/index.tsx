import React from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, AlertTriangle, ChevronRight } from "lucide-react-native";
import { railway } from "@/lib/railway";

/**
 * /safety — list of every safety alert dispatch has sent this driver.
 *
 * Rows show only the event type + truck + time; the dispatcher's
 * custom message body is intentionally hidden here (only revealed in
 * the detail screen). The push notification body carries the same
 * short summary — driver sees the full context only after they tap in.
 */

const DENVER_TZ = "America/Denver";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

export default function SafetyAlertsListScreen() {
  const router = useRouter();
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["driver-safety-alerts"],
    queryFn:  () => railway.listSafetyAlerts(),
    staleTime: 60_000,
  });
  const alerts = data?.alerts ?? [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f6f7f9" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e5e7eb" }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={{ marginRight: 12 }}>
          <ArrowLeft size={22} color="#111827" />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 18, color: "#111827" }]}>Safety alerts</Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
        }
      >
        {isLoading ? (
          <View style={{ padding: 40, alignItems: "center" }}>
            <ActivityIndicator />
          </View>
        ) : alerts.length === 0 ? (
          <View style={{ padding: 40, alignItems: "center" }}>
            <Text style={[txt(500), { color: "#6b7280", fontSize: 14 }]}>
              No safety alerts from dispatch.
            </Text>
          </View>
        ) : (
          alerts.map(a => (
            <TouchableOpacity
              key={a.id}
              activeOpacity={0.7}
              onPress={() => router.push(`/safety/${a.id}` as never)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                padding: 14,
                marginBottom: 8,
                borderRadius: 12,
                backgroundColor: "#fff",
                shadowColor: "#000",
                shadowOpacity: 0.04,
                shadowRadius: 4,
                shadowOffset: { width: 0, height: 1 },
              }}
            >
              <AlertTriangle size={20} color={severityColor(a.intensity)} />
              <View style={{ flex: 1 }}>
                <Text style={[txt(700), { fontSize: 15, color: "#111827" }]}>
                  {eventTypeLabel(a.event_type)}
                </Text>
                <Text style={[txt(500), { fontSize: 13, color: "#4b5563", marginTop: 2 }]}>
                  {a.truck_name ?? "Truck unknown"}
                  {a.truck_unit ? ` #${a.truck_unit}` : ""}
                </Text>
                <Text style={[txt(500), { fontSize: 12, color: "#6b7280", marginTop: 2 }]}>
                  {fmtDenver(a.event_time)}
                </Text>
              </View>
              <ChevronRight size={18} color="#9ca3af" />
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function eventTypeLabel(t: string): string {
  switch (t) {
    case "hard_accel":  return "Hard acceleration";
    case "hard_brake":  return "Hard brake";
    case "hard_corner": return "Hard cornering";
    case "tailgating":  return "Tailgating";
    case "cell_phone":  return "Phone use";
    case "distraction": return "Distraction";
    case "drowsiness":  return "Drowsiness";
    case "seatbelt":    return "Seatbelt violation";
    default:            return t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
}

function severityColor(intensity: string | null): string {
  const s = (intensity ?? "").toLowerCase();
  if (s.includes("severe") || s.includes("high")) return "#dc2626";
  if (s.includes("moderate")) return "#f59e0b";
  return "#3b82f6";
}

function fmtDenver(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone:     DENVER_TZ,
    month:        "short",
    day:          "numeric",
    hour:         "numeric",
    minute:       "2-digit",
    timeZoneName: "short",
  });
}
