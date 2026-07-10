import React, { useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, Modal, Alert as RNAlert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertTriangle, Truck, MapPin, MessageSquare, Clock, Flag, CheckCircle2, X, XCircle } from "lucide-react-native";
import { railway } from "@/lib/railway";

type SeverityLevel = "low" | "moderate" | "severe";

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
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const alertId = Number(id);

  const { data, isLoading, error } = useQuery({
    queryKey: ["driver-safety-alerts"],
    queryFn:  () => railway.listSafetyAlerts(),
    staleTime: 60_000,
  });

  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);

  async function submitDispute() {
    const reason = disputeReason.trim();
    if (reason.length < 5) {
      RNAlert.alert("Please add a reason", "Give dispatch a short explanation of why this alert isn't accurate.");
      return;
    }
    setDisputeSubmitting(true);
    try {
      await railway.disputeSafetyAlert(alertId, reason);
      // Invalidate so the screen re-renders with the new dispute status.
      await queryClient.invalidateQueries({ queryKey: ["driver-safety-alerts"] });
      await queryClient.invalidateQueries({ queryKey: ["driver-safety-score"] });
      setDisputeOpen(false);
      setDisputeReason("");
    } catch (err) {
      const msg = (err as { message?: string }).message ?? "Something went wrong.";
      RNAlert.alert("Couldn't send dispute", msg);
    }
    setDisputeSubmitting(false);
  }
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
                backgroundColor: severityColorLevel(alert.severity_level) + "22",
                alignItems: "center", justifyContent: "center",
              }}>
                <AlertTriangle size={24} color={severityColorLevel(alert.severity_level)} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 20, color: "#111827" }]}>
                  {eventTypeLabel(alert.event_type)}
                </Text>
                <Text style={[txt(600), { fontSize: 12, color: severityColorLevel(alert.severity_level), marginTop: 2, textTransform: "uppercase", letterSpacing: 0.6 }]}>
                  {alert.severity_level}
                </Text>
              </View>
            </View>

            {/* Severity meter — small bar showing where this event sits
                on Motive's intensity scale for this event type. Same
                math as the dispatch view. */}
            <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 16 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", marginBottom: 8 }}>
                <Text style={[txt(600), { fontSize: 13, color: "#374151" }]}>
                  {alert.severity_metric}
                </Text>
                <Text style={[txt(700), { fontSize: 14, color: severityColorLevel(alert.severity_level), marginLeft: "auto" }]}>
                  {alert.severity_display}
                </Text>
              </View>
              <View style={{
                height: 10, borderRadius: 5, backgroundColor: "#f3f4f6",
                overflow: "hidden", borderWidth: 1, borderColor: "#e5e7eb",
              }}>
                <View style={{
                  height: "100%",
                  width: `${Math.max(0, Math.min(100, alert.severity_score))}%`,
                  backgroundColor: severityColorLevel(alert.severity_level),
                  borderRadius: 4,
                }} />
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
              <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <MessageSquare size={16} color="#6b7280" />
                  <Text style={[txt(700), { fontSize: 13, color: "#374151" }]}>Message from dispatch</Text>
                </View>
                <Text style={[txt(500), { fontSize: 15, color: "#111827", lineHeight: 22 }]}>
                  {alert.notified_message}
                </Text>
              </View>
            )}

            {/* Dispute block — button when no dispute yet, status card
                otherwise. Once a dispute is filed the driver can't file
                another; dispatch reviews and either accepts (event
                dropped from score) or rejects (event stands). */}
            <DisputeBlock
              status={alert.dispute_status}
              reason={alert.dispute_reason}
              resolution={alert.dispute_resolution}
              disputedAt={alert.disputed_at}
              reviewedAt={alert.dispute_reviewed_at}
              onOpen={() => setDisputeOpen(true)}
            />
          </>
        )}
      </ScrollView>

      {/* Reason modal — only mounted when disputeOpen. */}
      <Modal
        visible={disputeOpen}
        transparent
        animationType="slide"
        onRequestClose={() => !disputeSubmitting && setDisputeOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Text style={[txt(700), { fontSize: 16, color: "#111827" }]}>Dispute this alert</Text>
              <TouchableOpacity onPress={() => !disputeSubmitting && setDisputeOpen(false)} disabled={disputeSubmitting}>
                <X size={20} color="#6b7280" />
              </TouchableOpacity>
            </View>
            <Text style={[txt(500), { fontSize: 13, color: "#6b7280", marginBottom: 12, lineHeight: 19 }]}>
              Tell dispatch why this alert isn't accurate. They'll review and either
              drop it from your score or explain why it stands.
            </Text>
            <TextInput
              value={disputeReason}
              onChangeText={setDisputeReason}
              placeholder="e.g. Sudden brake to avoid a cut-off, or I wasn't the driver at the time…"
              placeholderTextColor="#9ca3af"
              multiline
              autoFocus
              editable={!disputeSubmitting}
              style={[
                txt(500),
                {
                  minHeight: 100, maxHeight: 200,
                  borderWidth: 1, borderColor: "#e5e7eb",
                  borderRadius: 10, padding: 12,
                  fontSize: 14, color: "#111827",
                  textAlignVertical: "top",
                },
              ]}
            />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
              <TouchableOpacity
                onPress={() => setDisputeOpen(false)}
                disabled={disputeSubmitting}
                style={{
                  flex: 1, padding: 14, borderRadius: 10,
                  borderWidth: 1, borderColor: "#e5e7eb",
                  alignItems: "center",
                }}
              >
                <Text style={[txt(600), { fontSize: 14, color: "#374151" }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitDispute}
                disabled={disputeSubmitting || disputeReason.trim().length < 5}
                style={{
                  flex: 1, padding: 14, borderRadius: 10,
                  backgroundColor: disputeReason.trim().length < 5 ? "#e5e7eb" : "#dc2626",
                  alignItems: "center",
                }}
              >
                {disputeSubmitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={[txt(700), { fontSize: 14, color: disputeReason.trim().length < 5 ? "#9ca3af" : "#fff" }]}>
                    Send dispute
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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

function severityColorLevel(level: SeverityLevel): string {
  if (level === "severe")   return "#dc2626";
  if (level === "moderate") return "#f59e0b";
  return "#3b82f6";
}

// ── Dispute presentation block ──────────────────────────────────────
//
// Renders differently based on where the dispute is in the workflow:
//   none      → "Dispute this alert" button
//   pending   → "Under review" card showing what the driver wrote
//   accepted  → Green check "Dropped from your score" with dispatch note
//   rejected  → Amber flag "Dispute reviewed — event stands" with note

function DisputeBlock({
  status, reason, resolution, disputedAt, reviewedAt, onOpen,
}: {
  status:      "none" | "pending" | "accepted" | "rejected";
  reason:      string | null;
  resolution:  string | null;
  disputedAt:  string | null;
  reviewedAt:  string | null;
  onOpen:      () => void;
}) {
  if (status === "none") {
    return (
      <TouchableOpacity
        onPress={onOpen}
        activeOpacity={0.85}
        style={{
          flexDirection: "row", alignItems: "center", gap: 10,
          backgroundColor: "#fff", borderRadius: 14, padding: 16,
          borderWidth: 1, borderColor: "#e5e7eb",
        }}
      >
        <Flag size={16} color="#6b7280" />
        <View style={{ flex: 1 }}>
          <Text style={[txt(700), { fontSize: 13, color: "#111827" }]}>Dispute this alert</Text>
          <Text style={[txt(500), { fontSize: 12, color: "#6b7280", marginTop: 2 }]}>
            Tell dispatch if this alert isn't accurate — accepted disputes drop from your score.
          </Text>
        </View>
        <Text style={[txt(600), { fontSize: 14, color: "#6b7280" }]}>›</Text>
      </TouchableOpacity>
    );
  }

  const isPending  = status === "pending";
  const isAccepted = status === "accepted";
  const isRejected = status === "rejected";

  const bg =
    isAccepted ? "#e6f4ea" :
    isRejected ? "#fff8e6" :
                 "#eff6ff";
  const iconColor =
    isAccepted ? "#137333" :
    isRejected ? "#b06000" :
                 "#1a73e8";
  const StatusIcon = isAccepted ? CheckCircle2 : isRejected ? XCircle : Flag;
  const heading =
    isAccepted ? "Dispute accepted — dropped from your score" :
    isRejected ? "Dispute reviewed — event stands"              :
                 "Dispute under review";

  return (
    <View style={{ backgroundColor: bg, borderRadius: 14, padding: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <StatusIcon size={16} color={iconColor} />
        <Text style={[txt(700), { fontSize: 13, color: iconColor }]}>{heading}</Text>
      </View>
      {reason && (
        <View style={{ marginBottom: isPending || resolution ? 10 : 0 }}>
          <Text style={[txt(600), { fontSize: 11, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }]}>
            Your reason
          </Text>
          <Text style={[txt(500), { fontSize: 14, color: "#111827", lineHeight: 20 }]}>
            {reason}
          </Text>
          {disputedAt && (
            <Text style={[txt(500), { fontSize: 11, color: "#6b7280", marginTop: 3 }]}>
              Submitted {fmtDenver(disputedAt)}
            </Text>
          )}
        </View>
      )}
      {resolution && (
        <View>
          <Text style={[txt(600), { fontSize: 11, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }]}>
            Dispatch response
          </Text>
          <Text style={[txt(500), { fontSize: 14, color: "#111827", lineHeight: 20 }]}>
            {resolution}
          </Text>
          {reviewedAt && (
            <Text style={[txt(500), { fontSize: 11, color: "#6b7280", marginTop: 3 }]}>
              Reviewed {fmtDenver(reviewedAt)}
            </Text>
          )}
        </View>
      )}
      {isPending && !resolution && (
        <Text style={[txt(500), { fontSize: 12, color: "#374151", lineHeight: 18 }]}>
          Dispatch will review and let you know soon.
        </Text>
      )}
    </View>
  );
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
