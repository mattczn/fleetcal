/**
 * View-only sheet for a driver-submitted maintenance report.
 *
 * Brother's main job here is *triage*: read what came in, look at the
 * photos, decide whether it becomes a work order or gets dismissed.
 * The big primary button at the bottom kicks off conversion (the parent
 * pops the work-order sheet in convert mode pre-filled from this
 * report); the secondary button dismisses it.
 */
import React, { useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ScrollView,
  Alert, Image, ActivityIndicator,
} from "react-native";
import { X, Wrench, EyeOff } from "lucide-react-native";
import type { MaintenanceReport, Asset, Trailer } from "@fleetcal/types";
import { txt } from "@/lib/font";
import { railway } from "@/lib/railway";
import { ReportStatusPill, fmtTimestamp } from "@/lib/maintenanceUI";

interface Props {
  visible:  boolean;
  report:   MaintenanceReport | null;
  assets:   Asset[];
  trailers: Trailer[];
  drivers:  { id: number; name: string }[];
  onClose:    () => void;
  onMutated:  () => void;
  /** Open the work-order sheet in convert mode for this report. The
   *  parent owns both sheets so it can sequence the open/close
   *  transition without us holding state. */
  onConvert:  (report: MaintenanceReport) => void;
}

export function MaintenanceReportSheet({
  visible, report, assets, trailers, drivers, onClose, onMutated, onConvert,
}: Props) {
  const [busy, setBusy] = useState(false);
  if (!report) return null;

  const driver  = drivers.find((d) => d.id === report.driverId);
  const asset   = report.assetId   ? assets.find((a) => a.id === report.assetId)     : null;
  const trailer = report.trailerId ? trailers.find((t) => t.id === report.trailerId) : null;

  async function dismiss() {
    if (!report) return;
    setBusy(true);
    try {
      await railway.updateMaintenanceReport(report.id, { status: "dismissed" });
      onMutated();
      onClose();
    } catch (err) {
      console.error("dismiss report:", err);
      Alert.alert("Failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  const photos = report.photos ?? [];
  const isConverted = report.status === "converted";
  // Legacy 'reviewed' means exactly what 'dismissed' means (see
  // MaintenanceReportStatus) — a report in either state is settled, so
  // the Dismiss action is already spent.
  const isDismissed = report.status === "dismissed" || report.status === "reviewed";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: "88%",
            paddingTop: 8,
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: "row", alignItems: "center",
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <Text style={[txt(800), { fontSize: 17, color: "#202124", flex: 1 }]}>
              Driver Report
            </Text>
            <ReportStatusPill status={report.status} />
            <TouchableOpacity onPress={onClose} hitSlop={10} style={{ marginLeft: 12 }}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ maxHeight: 600 }}
            contentContainerStyle={{ padding: 18, paddingBottom: 24 }}
          >
            {/* Meta row */}
            <View style={{ marginBottom: 16 }}>
              <Text style={[txt(700), { fontSize: 12, color: "#9aa0a6", marginBottom: 4 }]}>
                {fmtTimestamp(report.reportedAt)}
              </Text>
              <Text style={[txt(800), { fontSize: 15, color: "#202124" }]}>
                {driver?.name ?? "Unknown driver"}
              </Text>
              <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginTop: 2 }]}>
                {asset
                  ? asset.name
                  : trailer
                    ? (trailer.trailerNumber ? `Trailer ${trailer.trailerNumber}` : trailer.name)
                    : "—"}
              </Text>
            </View>

            {/* Description */}
            <Text style={[txt(700), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4, marginBottom: 6 }]}>
              REPORT
            </Text>
            <Text style={[txt(500), { fontSize: 14, color: "#202124", lineHeight: 20 }]}>
              {report.description}
            </Text>

            {/* Photos */}
            {photos.length > 0 ? (
              <>
                <Text style={[txt(700), { fontSize: 11, color: "#5f6368", letterSpacing: 0.4, marginTop: 20, marginBottom: 8 }]}>
                  PHOTOS ({photos.length})
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {photos.map((p) => (
                    p.signedUrl ? (
                      <Image
                        key={p.id}
                        source={{ uri: p.signedUrl }}
                        style={{ width: 100, height: 100, borderRadius: 8, backgroundColor: "#f1f3f4" }}
                      />
                    ) : (
                      <View key={p.id} style={{
                        width: 100, height: 100, borderRadius: 8, backgroundColor: "#f1f3f4",
                        alignItems: "center", justifyContent: "center",
                      }}>
                        <ActivityIndicator size="small" color="#9aa0a6" />
                      </View>
                    )
                  ))}
                </View>
              </>
            ) : null}

            {/* Already-converted hint */}
            {isConverted ? (
              <View style={{
                marginTop: 20, padding: 12, borderRadius: 10,
                backgroundColor: "#e6f4ea",
              }}>
                <Text style={[txt(700), { fontSize: 12, color: "#1e8e3e" }]}>
                  This report was already converted to a work order.
                </Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Action bar */}
          <View style={{
            paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28,
            borderTopWidth: 1, borderTopColor: "#f1f3f4",
            backgroundColor: "#ffffff",
          }}>
            {!isConverted ? (
              <TouchableOpacity
                onPress={() => onConvert(report)}
                disabled={busy}
                activeOpacity={0.85}
                style={{
                  backgroundColor: "#1a73e8",
                  paddingVertical: 14, borderRadius: 12,
                  flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                }}
              >
                <Wrench size={16} color="#ffffff" strokeWidth={2.4} />
                <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                  Convert to Work Order
                </Text>
              </TouchableOpacity>
            ) : null}

            {/* Single triage-out action. There used to be a second
                "Mark reviewed" button next to this one that wrote
                status='reviewed' — a different name for the same thing
                the web calls "Ignore", which then disagreed with this
                app about whether the report was still pending. One
                button, one wire value ('dismissed'), and the eye-off
                glyph matches the web's Ignore control. */}
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 18, marginTop: 12 }}>
              {!isConverted && !isDismissed ? (
                <TouchableOpacity
                  onPress={dismiss}
                  disabled={busy}
                  hitSlop={8}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                >
                  <EyeOff size={14} color="#5f6368" strokeWidth={2.2} />
                  <Text style={[txt(700), { fontSize: 13, color: "#5f6368" }]}>
                    Dismiss
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
