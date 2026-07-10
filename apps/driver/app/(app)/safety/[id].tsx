import React from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, AlertTriangle, Truck, MapPin, MessageSquare, Clock } from "lucide-react-native";
import { railway } from "@/lib/railway";

/**
 * /safety/[id] — detail for one safety alert.
 *
 * Push-notification target. When dispatch fires the push, the data
 * payload includes `url: "/safety/<id>"` which useNotificationDeepLink
 * routes here on tap. This screen shows the full context — including
 * the dispatcher's custom message body, which the push notification
 * intentionally omitted.
 */

const DENVER_TZ = "America/Denver";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

export default function SafetyAlertDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const alertId = Number(id);

  const { data, isLoading, error } = useQuery({
    queryKey: ["driver-safety-alerts"],
    queryFn:  () => railway.listSafetyAlerts(),
    staleTime: 60_000,
  });
  const alert = data?.alerts.find(a => a.id === alertId);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f6f7f9" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e5e7eb" }}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={{ marginRight: 12 }}>
          <ArrowLeft size={22} color="#111827" />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 18, color: "#111827" }]}>Safety alert</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {isLoading ? (
          <View style={{ padding: 40, alignItems: "center" }}>
            <ActivityIndicator />
          </View>
        ) : error || !alert ? (
          <View style={{ padding: 40, alignItems: "center" }}>
            <Text style={[txt(500), { color: "#6b7280", fontSize: 14, textAlign: "center" }]}>
              Couldn't find this alert. It may have been dismissed or you may not have permission to view it.
            </Text>
          </View>
        ) : (
          <>
            {/* Header row: event type + severity color */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16, padding: 16, backgroundColor: "#fff", borderRadius: 14 }}>
              <View style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: severityColor(alert.intensity) + "22",
                alignItems: "center", justifyContent: "center",
              }}>
                <AlertTriangle size={24} color={severityColor(alert.intensity)} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 20, color: "#111827" }]}>
                  {eventTypeLabel(alert.event_type)}
                </Text>
                {alert.intensity && (
                  <Text style={[txt(500), { fontSize: 13, color: "#6b7280", marginTop: 2 }]}>
                    Intensity: {alert.intensity}
                  </Text>
                )}
              </View>
            </View>

            {/* Context block: truck, location, event time, notified time */}
            <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 16, gap: 12 }}>
              <ContextRow
                icon={<Truck size={16} color="#6b7280" />}
                label="Truck"
                value={alert.truck_name ? `${alert.truck_name}${alert.truck_unit ? ` #${alert.truck_unit}` : ""}` : "Unknown"}
              />
              {alert.location_label && (
                <ContextRow icon={<MapPin size={16} color="#6b7280" />} label="Location" value={alert.location_label} />
              )}
              <ContextRow
                icon={<Clock size={16} color="#6b7280" />}
                label="When it happened"
                value={fmtDenver(alert.event_time)}
              />
              <ContextRow
                icon={<Clock size={16} color="#6b7280" />}
                label="Notified"
                value={fmtDenver(alert.notified_at)}
              />
            </View>

            {/* Dispatcher's message — only rendered here, never in the
                push notification. Only visible to the driver after tap. */}
            {alert.notified_message && (
              <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <MessageSquare size={16} color="#6b7280" />
                  <Text style={[txt(700), { fontSize: 13, color: "#374151" }]}>Message from dispatch</Text>
                </View>
                <Text style={[txt(500), { fontSize: 15, color: "#111827", lineHeight: 22 }]}>
                  {alert.notified_message}
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ContextRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={[txt(500), { fontSize: 11, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 0.5 }]}>
          {label}
        </Text>
        <Text style={[txt(600), { fontSize: 14, color: "#111827", marginTop: 2 }]}>
          {value}
        </Text>
      </View>
    </View>
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
    year:         "numeric",
    month:        "short",
    day:          "numeric",
    hour:         "numeric",
    minute:       "2-digit",
    timeZoneName: "short",
  });
}
