/**
 * Detail view for a single maintenance report. Used by the driver's
 * Report tab to drill into previously-submitted reports — shows every
 * field plus a photo grid that taps into a full-screen viewer.
 *
 * Bottom-sheet modal (consistent with the rest of the driver app's
 * detail UIs). The full-screen photo viewer lives inline as a second
 * modal layered on top so the gallery stays visible underneath.
 */
import React, { useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ScrollView,
  Image, Dimensions, ActivityIndicator,
} from "react-native";
import { X, MapPin, Calendar, Truck, Container, FileText } from "lucide-react-native";
import type { MaintenanceReport } from "@fleetcal/types";
import { useTheme } from "@/lib/ThemeProvider";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const SCREEN_W = Dimensions.get("window").width;
// Three-column photo grid with a small gap between tiles.
const PHOTO_GAP = 6;
const PHOTO_SIZE = (SCREEN_W - 32 /* outer padding */ - PHOTO_GAP * 2) / 3;

interface Props {
  visible:    boolean;
  report:     MaintenanceReport | null;
  /** Pre-resolved label for assetId / trailerId so the sheet can show
   *  "Truck #5180" instead of just an id. Caller passes whichever
   *  matches the report's target. */
  targetLabel?: string;
  /** 'asset' | 'trailer' for icon selection. */
  targetKind?: "asset" | "trailer";
  /** Optional driver/dispatcher display name to surface on the card.
   *  Reports filed by someone else (when this view is reused for an
   *  asset-history rail) deserve a "Reported by …" line. */
  reporterName?: string;
  onClose:    () => void;
}

function statusTint(C: ReturnType<typeof useTheme>["C"]): Record<string, { bg: string; fg: string; label: string }> {
  return {
    open:      { bg: C.amberBg, fg: C.amberInk, label: "Open" },
    converted: { bg: C.greenBg, fg: C.greenInk, label: "Scheduled" },
    dismissed: { bg: C.borderSoft, fg: C.t2,    label: "Dismissed" },
    // Legacy alias — 'reviewed' is the same settled state as
    // 'dismissed' (see MaintenanceReportStatus in @fleetcal/types).
    reviewed:  { bg: C.borderSoft, fg: C.t2,    label: "Dismissed" },
  };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function MaintenanceReportDetailSheet({
  visible, report, targetLabel, targetKind, reporterName, onClose,
}: Props) {
  const { C, SHADOW, ACCENT } = useTheme();
  // Full-screen photo viewer state — index into report.photos.
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);

  // Reset photo viewer whenever the sheet closes so the next open
  // starts on the grid, not whatever photo was last viewed.
  React.useEffect(() => {
    if (!visible) setPhotoIndex(null);
  }, [visible]);

  if (!report) return null;

  const STATUS_TINT = statusTint(C);
  const status = STATUS_TINT[report.status] ?? STATUS_TINT.open;
  const photos = report.photos ?? [];
  const TargetIcon = targetKind === "trailer" ? Container : Truck;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: C.surface,
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            maxHeight: "92%",
            minHeight: 400,
          }}
        >
          {/* Header */}
          <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: "center", marginBottom: 12 }} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 18, color: C.t1 }]}>
                  Maintenance Report
                </Text>
                <Text style={[txt(500), { fontSize: 12, color: C.t3, marginTop: 2 }]}>
                  {fmtDate(report.reportedAt)}
                </Text>
              </View>
              <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: status.bg }}>
                <Text style={[txt(700), { fontSize: 11, color: status.fg }]}>{status.label}</Text>
              </View>
              <TouchableOpacity onPress={onClose} hitSlop={10}>
                <X size={22} color={C.t3} strokeWidth={2.2} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 30 }}>
            {/* Target (asset or trailer) */}
            {(targetLabel || report.assetId || report.trailerId) && (
              <Row icon={<TargetIcon size={14} color={ACCENT} strokeWidth={2.2} />}
                   label={targetKind === "trailer" ? "Trailer" : "Truck"}
                   value={targetLabel ?? (report.assetId ? `#${report.assetId}` : `#${report.trailerId}`)} />
            )}

            {/* Reporter */}
            {reporterName && (
              <Row icon={<FileText size={14} color={ACCENT} strokeWidth={2.2} />}
                   label="Reported by"
                   value={reporterName} />
            )}

            {/* Location — state + lat/lng if captured */}
            {(report.state || report.latitude != null) && (
              <Row icon={<MapPin size={14} color={ACCENT} strokeWidth={2.2} />}
                   label="Location"
                   value={[
                     report.state,
                     report.latitude != null && report.longitude != null
                       ? `${report.latitude.toFixed(4)}, ${report.longitude.toFixed(4)}`
                       : null,
                   ].filter(Boolean).join(" · ") || "—"} />
            )}

            {/* Created timestamp — distinct from reported_at when
                offline-queued reports are submitted later. */}
            {report.createdAt && report.createdAt !== report.reportedAt && (
              <Row icon={<Calendar size={14} color={ACCENT} strokeWidth={2.2} />}
                   label="Submitted"
                   value={fmtDate(report.createdAt)} />
            )}

            {/* Description — the meat of the report */}
            <View style={{ marginTop: 16 }}>
              <Text style={[txt(800), { fontSize: 11, color: C.t3, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }]}>
                Description
              </Text>
              <View style={{ backgroundColor: C.bg, borderRadius: 10, padding: 12 }}>
                <Text style={[txt(500), { fontSize: 14, color: C.t1, lineHeight: 20 }]}>
                  {report.description || "—"}
                </Text>
              </View>
            </View>

            {/* Photo grid */}
            <View style={{ marginTop: 18 }}>
              <Text style={[txt(800), { fontSize: 11, color: C.t3, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }]}>
                Photos {photos.length > 0 ? `(${photos.length})` : ""}
              </Text>
              {photos.length === 0 ? (
                <Text style={[txt(500), { fontSize: 13, color: C.t4, paddingVertical: 8 }]}>
                  No photos attached.
                </Text>
              ) : (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: PHOTO_GAP }}>
                  {photos.map((p, idx) => (
                    <TouchableOpacity
                      key={p.id}
                      onPress={() => setPhotoIndex(idx)}
                      activeOpacity={0.85}
                      style={{ width: PHOTO_SIZE, height: PHOTO_SIZE, borderRadius: 8, overflow: "hidden", backgroundColor: C.borderSoft }}
                    >
                      {p.signedUrl ? (
                        <Image
                          source={{ uri: p.signedUrl }}
                          style={{ width: "100%", height: "100%" }}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                          <Text style={[txt(500), { fontSize: 10, color: C.t4, textAlign: "center" }]}>
                            No preview
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>

      {/* Full-screen photo viewer — opens on tap of any tile. */}
      {photoIndex !== null && photos[photoIndex] && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setPhotoIndex(null)}>
          <Pressable
            onPress={() => setPhotoIndex(null)}
            style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" }}
          >
            <TouchableOpacity
              onPress={() => setPhotoIndex(null)}
              style={{ position: "absolute", top: 50, right: 20, padding: 10, zIndex: 10 }}
              hitSlop={12}
            >
              <X size={28} color="#ffffff" strokeWidth={2.4} />
            </TouchableOpacity>
            {photos[photoIndex].signedUrl ? (
              <Image
                source={{ uri: photos[photoIndex].signedUrl }}
                style={{ width: SCREEN_W, height: SCREEN_W * 1.3 }}
                resizeMode="contain"
              />
            ) : (
              <ActivityIndicator color="#ffffff" />
            )}
            <Text style={[txt(500), { fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 18 }]}>
              {photoIndex + 1} of {photos.length}
            </Text>
          </Pressable>
        </Modal>
      )}
    </Modal>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  const { C } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}>
      <View style={{ width: 22, alignItems: "center" }}>{icon}</View>
      <Text style={[txt(700), { fontSize: 12, color: C.t3, width: 100 }]}>
        {label}
      </Text>
      <Text style={[txt(600), { fontSize: 14, color: C.t1, flex: 1 }]}>
        {value}
      </Text>
    </View>
  );
}
