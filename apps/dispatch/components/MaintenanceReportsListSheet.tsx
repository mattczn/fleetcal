/**
 * List sheet for driver-submitted maintenance reports.
 *
 * Used to be a sub-tab next to "Orders" on the maintenance screen;
 * promoted to a sheet behind a quick-link button so the main view
 * stays focused on the scheduling calendar. Tapping a row hands the
 * report back to the parent so it can pop the existing
 * MaintenanceReportSheet for full triage (the parent owns sheet
 * stacking so we don't fight RN's modal layering rules).
 */
import React from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ScrollView, RefreshControl,
} from "react-native";
import { X, Inbox } from "lucide-react-native";
import type { MaintenanceReport, Asset, Trailer, Driver } from "@fleetcal/types";
import { txt } from "@/lib/font";

interface Props {
  visible:  boolean;
  reports:  MaintenanceReport[];
  drivers:  Driver[];
  assets:   Asset[];
  trailers: Trailer[];
  refreshing: boolean;
  onClose:   () => void;
  onRefresh: () => void;
  onOpenReport: (report: MaintenanceReport) => void;
}

export function MaintenanceReportsListSheet({
  visible, reports, drivers, assets, trailers, refreshing,
  onClose, onRefresh, onOpenReport,
}: Props) {
  const pendingCount = reports.filter(
    (r) => r.status === "open" || r.status === "reviewed",
  ).length;

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
            height: "92%",
            paddingTop: 8,
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: "row", alignItems: "center",
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <Inbox size={18} color="#1a73e8" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 17, color: "#202124", marginLeft: 10, flex: 1 }]}>
              Driver Reports
            </Text>
            {pendingCount > 0 ? (
              <View style={{
                minWidth: 22, height: 22, paddingHorizontal: 7, borderRadius: 11,
                backgroundColor: "#ea4335",
                alignItems: "center", justifyContent: "center",
                marginRight: 12,
              }}>
                <Text style={[txt(800), { fontSize: 11, color: "#ffffff" }]}>{pendingCount}</Text>
              </View>
            ) : null}
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={{ paddingTop: 12, paddingBottom: 32 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1a73e8" />}
          >
            {reports.length === 0 ? (
              <View style={{ paddingVertical: 80, alignItems: "center", paddingHorizontal: 32 }}>
                <Inbox size={28} color="#dadce0" strokeWidth={2} />
                <Text style={[txt(700), { fontSize: 14, color: "#5f6368", marginTop: 10 }]}>
                  No driver reports yet
                </Text>
                <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
                  When a driver flags maintenance from the driver app it'll land here.
                </Text>
              </View>
            ) : (
              reports.map((r) => (
                <ReportRow
                  key={r.id}
                  report={r}
                  drivers={drivers}
                  assets={assets}
                  trailers={trailers}
                  onPress={() => onOpenReport(r)}
                />
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ReportRow({
  report, drivers, assets, trailers, onPress,
}: {
  report:   MaintenanceReport;
  drivers:  Driver[];
  assets:   Asset[];
  trailers: Trailer[];
  onPress:  () => void;
}) {
  const driver  = drivers.find((d) => d.id === report.driverId);
  const asset   = report.assetId   ? assets.find((a) => a.id === report.assetId)     : null;
  const trailer = report.trailerId ? trailers.find((t) => t.id === report.trailerId) : null;
  const equipmentLabel = asset
    ? asset.name
    : trailer
      ? (trailer.trailerNumber ? `Trailer ${trailer.trailerNumber}` : trailer.name)
      : "—";
  const isPending = report.status === "open" || report.status === "reviewed";

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        backgroundColor: "#ffffff",
        marginHorizontal: 14, marginBottom: 8,
        borderRadius: 10,
        borderWidth: 1, borderColor: isPending ? "#fce8e6" : "#eef0f2",
        padding: 12, gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[txt(800), { fontSize: 13, color: "#202124", flex: 1 }]} numberOfLines={1}>
          {driver?.name ?? "Unknown driver"}
        </Text>
        <Text style={[txt(700), { fontSize: 11, color: "#9aa0a6" }]}>
          {new Date(report.reportedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </Text>
      </View>
      <Text style={[txt(600), { fontSize: 12, color: "#5f6368" }]} numberOfLines={1}>
        {equipmentLabel}
      </Text>
      <Text style={[txt(500), { fontSize: 13, color: "#202124", marginTop: 2 }]} numberOfLines={2}>
        {report.description}
      </Text>
      {(report.photos?.length ?? 0) > 0 ? (
        <Text style={[txt(700), { fontSize: 10, color: "#1967d2", marginTop: 2 }]}>
          {report.photos!.length} photo{report.photos!.length === 1 ? "" : "s"}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}
