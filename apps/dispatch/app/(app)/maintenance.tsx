/**
 * Maintenance — ops mobile triage view.
 *
 * Two sections in a segmented control:
 *   - Reports     → driver-submitted issue reports awaiting triage
 *   - Action Items → tracked work created from reports or ad-hoc
 *
 * Tap a row → opens a detail modal. From there ops can change
 * status, convert a report into an action item, mark an action item
 * done, or delete. Mirrors the web maintenance dashboard but trimmed
 * down to the actions actually useful on a phone.
 */
import React, { useMemo, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, Modal, Pressable, RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useOrganization } from "@clerk/clerk-expo";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, AlertTriangle, Truck, Container, ChevronRight, X,
  Wrench, Clock, ChevronUp, ChevronDown, Check, Image as ImageIcon,
} from "lucide-react-native";
import { railway } from "@/lib/railway";
import { fetchAssets, fetchTrailers } from "@/lib/api";
import { txt } from "@/lib/font";
import type {
  MaintenanceReport, MaintenanceReportPhoto, MaintenanceActionItem,
  MaintenanceActionStatus, MaintenancePriority,
} from "@/lib/types";

// ─── Display helpers ────────────────────────────────────────────────────

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

const PRIORITY_COLOR: Record<MaintenancePriority, string> = {
  urgent: "#b91c1c",
  high:   "#c2410c",
  normal: "#5f6368",
  low:    "#9aa0a6",
};

const STATUS_COLOR: Record<MaintenanceActionStatus, string> = {
  open:        "#dc2626",
  in_progress: "#e37400",
  done:        "#188038",
};

const STATUS_LABEL: Record<MaintenanceActionStatus, string> = {
  open:        "Open",
  in_progress: "In Progress",
  done:        "Done",
};

// ─── Asset / Trailer name resolver ──────────────────────────────────────

function useAssetNames(orgId: string | undefined) {
  const { data: assets = [] } = useQuery({
    queryKey: ["assets", orgId],
    queryFn:  () => fetchAssets(orgId!),
    enabled:  !!orgId,
    staleTime: 5 * 60_000,
  });
  const { data: trailers = [] } = useQuery({
    queryKey: ["trailers", orgId],
    queryFn:  () => fetchTrailers(orgId!),
    enabled:  !!orgId,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const assetById = new Map<number, string>();
    for (const a of assets) {
      assetById.set(a.id, `${a.name}${a.unit ? ` · ${a.unit}` : ""}`);
    }
    const trailerById = new Map<number, string>();
    for (const t of trailers) {
      trailerById.set(t.id, `${t.name}${t.trailerNumber ? ` · ${t.trailerNumber}` : ""}`);
    }
    return { assetById, trailerById };
  }, [assets, trailers]);
}

// ─── Screen ─────────────────────────────────────────────────────────────

export default function MaintenanceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"reports" | "actions">("reports");
  const [selectedReport, setSelectedReport] = useState<MaintenanceReport | null>(null);
  const [selectedItem,   setSelectedItem]   = useState<MaintenanceActionItem | null>(null);

  const reportsQ = useQuery({
    queryKey: ["maintenance-reports", orgId, "open"],
    queryFn:  async () => (await railway.listMaintenanceReports({ status: "open" })).reports,
    enabled:  !!orgId,
  });
  const itemsQ = useQuery({
    queryKey: ["maintenance-action-items", orgId],
    queryFn:  async () => (await railway.listMaintenanceActionItems({})).actionItems,
    enabled:  !!orgId,
  });

  const { assetById, trailerById } = useAssetNames(orgId);
  const labelFor = (assetId?: number, trailerId?: number) =>
    assetId   ? assetById.get(assetId)     ?? `Asset #${assetId}`
    : trailerId ? trailerById.get(trailerId) ?? `Trailer #${trailerId}`
    : "—";

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["maintenance-reports", orgId] });
    queryClient.invalidateQueries({ queryKey: ["maintenance-action-items", orgId] });
  }

  const reports = reportsQ.data ?? [];
  const items   = itemsQ.data   ?? [];
  const openItems = items.filter(i => i.status !== "done");
  const doneItems = items.filter(i => i.status === "done");

  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top,
          backgroundColor: "#1a73e8",
          paddingHorizontal: 16, paddingBottom: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingTop: 8 }}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10}
            style={{ padding: 4, marginRight: 8 }}>
            <ArrowLeft size={22} color="#fff" strokeWidth={2.2} />
          </TouchableOpacity>
          <Text style={[txt(800), { fontSize: 18, color: "#fff", flex: 1 }]}>Maintenance</Text>
          <TouchableOpacity onPress={refresh} hitSlop={10}>
            <Clock size={18} color="rgba(255,255,255,0.85)" strokeWidth={2.2} />
          </TouchableOpacity>
        </View>

        {/* Segmented control */}
        <View
          style={{
            flexDirection: "row",
            backgroundColor: "rgba(255,255,255,0.18)",
            borderRadius: 10,
            padding: 3,
            marginTop: 14,
          }}
        >
          {([
            { key: "reports", label: `Reports${reports.length > 0 ? ` · ${reports.length}` : ""}` },
            { key: "actions", label: `Action Items${openItems.length > 0 ? ` · ${openItems.length}` : ""}` },
          ] as const).map(t => {
            const active = tab === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                onPress={() => setTab(t.key)}
                activeOpacity={0.85}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  alignItems: "center",
                  borderRadius: 8,
                  backgroundColor: active ? "#ffffff" : "transparent",
                }}
              >
                <Text style={[txt(700), {
                  fontSize: 12,
                  color: active ? "#1a73e8" : "rgba(255,255,255,0.9)",
                  letterSpacing: 0.2,
                }]}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Body */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={reportsQ.isFetching || itemsQ.isFetching}
            onRefresh={refresh}
            tintColor="#1a73e8"
          />
        }
      >
        {tab === "reports" ? (
          reportsQ.isLoading ? (
            <ActivityIndicator color="#1a73e8" style={{ marginTop: 40 }} />
          ) : reports.length === 0 ? (
            <EmptyState
              icon={<AlertTriangle size={26} color="#9aa0a6" />}
              title="No open reports"
              subtitle="Driver-submitted issues will appear here for triage."
            />
          ) : (
            reports.map(r => (
              <ReportRow
                key={r.id}
                report={r}
                assetLabel={labelFor(r.assetId, r.trailerId)}
                onPress={() => setSelectedReport(r)}
              />
            ))
          )
        ) : (
          itemsQ.isLoading ? (
            <ActivityIndicator color="#1a73e8" style={{ marginTop: 40 }} />
          ) : (
            <>
              {openItems.length === 0 && doneItems.length === 0 ? (
                <EmptyState
                  icon={<Wrench size={26} color="#9aa0a6" />}
                  title="No action items"
                  subtitle="Convert a report or add a manual item to get started."
                />
              ) : null}
              {openItems.length > 0 ? (
                <>
                  <SectionLabel text="Open" />
                  {openItems.map(i => (
                    <ActionItemRow
                      key={i.id}
                      item={i}
                      assetLabel={labelFor(i.assetId, i.trailerId)}
                      onPress={() => setSelectedItem(i)}
                    />
                  ))}
                </>
              ) : null}
              {doneItems.length > 0 ? (
                <>
                  <SectionLabel text={`Completed · ${doneItems.length}`} />
                  {doneItems.slice(0, 20).map(i => (
                    <ActionItemRow
                      key={i.id}
                      item={i}
                      assetLabel={labelFor(i.assetId, i.trailerId)}
                      onPress={() => setSelectedItem(i)}
                      dimmed
                    />
                  ))}
                </>
              ) : null}
            </>
          )
        )}
      </ScrollView>

      {/* Detail modals */}
      <ReportDetailModal
        report={selectedReport}
        assetLabel={selectedReport ? labelFor(selectedReport.assetId, selectedReport.trailerId) : ""}
        onClose={() => setSelectedReport(null)}
        onChange={() => { refresh(); setSelectedReport(null); }}
      />
      <ActionItemDetailModal
        item={selectedItem}
        assetLabel={selectedItem ? labelFor(selectedItem.assetId, selectedItem.trailerId) : ""}
        onClose={() => setSelectedItem(null)}
        onChange={() => { refresh(); setSelectedItem(null); }}
      />
    </View>
  );
}

// ─── List row components ────────────────────────────────────────────────

function SectionLabel({ text }: { text: string }) {
  return (
    <Text style={[txt(800), {
      fontSize: 11, letterSpacing: 1.1, color: "#5f6368",
      textTransform: "uppercase", marginTop: 14, marginBottom: 8,
    }]}>{text}</Text>
  );
}

function ReportRow({ report, assetLabel, onPress }: {
  report: MaintenanceReport;
  assetLabel: string;
  onPress: () => void;
}) {
  const isTrailer = report.trailerId != null;
  const Icon = isTrailer ? Container : Truck;
  const photoCount = report.photos?.length ?? 0;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}
      style={{
        backgroundColor: "#ffffff",
        borderRadius: 14,
        marginBottom: 10,
        padding: 14,
        borderWidth: 1, borderColor: "#e8eaed",
        flexDirection: "row", alignItems: "flex-start", gap: 12,
      }}>
      <View style={{
        width: 38, height: 38, borderRadius: 10,
        backgroundColor: "#fef3c7", alignItems: "center", justifyContent: "center",
      }}>
        <Icon size={16} color="#9a3412" strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <Text style={[txt(700), { fontSize: 13, color: "#3c4043", flex: 1 }]} numberOfLines={1}>
            {assetLabel}
          </Text>
          <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6" }]}>
            {fmtRelative(report.reportedAt)}
          </Text>
        </View>
        <Text style={[txt(600), { fontSize: 14, color: "#202124", lineHeight: 19 }]} numberOfLines={3}>
          {report.description}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 }}>
          <Text style={[txt(500), { fontSize: 11, color: "#5f6368" }]}>
            {report.submittedBy}
          </Text>
          {photoCount > 0 ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
              <ImageIcon size={11} color="#5f6368" strokeWidth={2.2} />
              <Text style={[txt(600), { fontSize: 11, color: "#5f6368" }]}>{photoCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
      <ChevronRight size={18} color="#9aa0a6" strokeWidth={2.2} style={{ marginTop: 8 }} />
    </TouchableOpacity>
  );
}

function ActionItemRow({ item, assetLabel, onPress, dimmed }: {
  item: MaintenanceActionItem;
  assetLabel: string;
  onPress: () => void;
  dimmed?: boolean;
}) {
  const isTrailer = item.trailerId != null;
  const Icon = isTrailer ? Container : Truck;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85}
      style={{
        backgroundColor: "#ffffff",
        borderRadius: 14,
        marginBottom: 10,
        padding: 14,
        borderWidth: 1, borderColor: "#e8eaed",
        flexDirection: "row", alignItems: "center", gap: 12,
        opacity: dimmed ? 0.55 : 1,
      }}>
      <View
        style={{
          width: 4, alignSelf: "stretch", borderRadius: 2,
          backgroundColor: PRIORITY_COLOR[item.priority],
        }}
      />
      <View style={{
        width: 38, height: 38, borderRadius: 10,
        backgroundColor: "#e8f0fe", alignItems: "center", justifyContent: "center",
      }}>
        <Icon size={16} color="#1a73e8" strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[txt(700), { fontSize: 14, color: "#202124" }]} numberOfLines={1}>
          {item.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
          <Text style={[txt(500), { fontSize: 12, color: "#5f6368" }]} numberOfLines={1}>
            {assetLabel}
          </Text>
          <Pill text={STATUS_LABEL[item.status]} color={STATUS_COLOR[item.status]} />
          {item.outOfService ? <Pill text="OOS" color="#b91c1c" /> : null}
        </View>
      </View>
      <ChevronRight size={18} color="#9aa0a6" strokeWidth={2.2} />
    </TouchableOpacity>
  );
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View style={{
      paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999,
      backgroundColor: `${color}18`,
    }}>
      <Text style={[txt(700), { fontSize: 10, color, letterSpacing: 0.2 }]}>{text}</Text>
    </View>
  );
}

function EmptyState({ icon, title, subtitle }: {
  icon: React.ReactNode; title: string; subtitle: string;
}) {
  return (
    <View style={{ paddingVertical: 50, alignItems: "center" }}>
      <View style={{
        width: 64, height: 64, borderRadius: 32,
        backgroundColor: "#f1f3f4",
        alignItems: "center", justifyContent: "center",
        marginBottom: 12,
      }}>{icon}</View>
      <Text style={[txt(700), { fontSize: 15, color: "#3c4043", textAlign: "center" }]}>{title}</Text>
      <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", textAlign: "center", marginTop: 4, paddingHorizontal: 40 }]}>{subtitle}</Text>
    </View>
  );
}

// ─── Report detail ──────────────────────────────────────────────────────

function ReportDetailModal({ report, assetLabel, onClose, onChange }: {
  report: MaintenanceReport | null;
  assetLabel: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const convertMut = useMutation({
    mutationFn: (id: string) => railway.convertMaintenanceReport(id, {}),
    onSuccess: () => onChange(),
    onError: (err: Error) => Alert.alert("Convert failed", err.message),
  });
  const updateMut = useMutation({
    mutationFn: (args: { id: string; status: "reviewed" | "dismissed" }) =>
      railway.updateMaintenanceReport(args.id, { status: args.status }),
    onSuccess: () => onChange(),
    onError: (err: Error) => Alert.alert("Update failed", err.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => railway.deleteMaintenanceReport(id),
    onSuccess: () => onChange(),
    onError: (err: Error) => Alert.alert("Delete failed", err.message),
  });

  if (!report) return null;
  const busy = convertMut.isPending || updateMut.isPending || deleteMut.isPending;

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }}>
        <Pressable onPress={(e) => e.stopPropagation()}
          style={{
            marginTop: "auto", maxHeight: "85%",
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingTop: 10, paddingBottom: 24,
          }}>
          <View style={{ alignItems: "center", paddingVertical: 8 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: "#e8eaed" }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 18, marginBottom: 8 }}>
            <Text style={[txt(800), { fontSize: 18, color: "#202124", flex: 1 }]}>Report</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={22} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 12 }}>
            <DetailRow label="Asset" value={assetLabel} />
            <DetailRow label="Submitted by" value={`${report.submittedBy} · ${fmtDateTime(report.reportedAt)}`} />
            {report.state ? <DetailRow label="Location" value={report.state} /> : null}
            <View style={{ marginTop: 14 }}>
              <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase" }]}>Description</Text>
              <Text style={[txt(500), { fontSize: 14, color: "#202124", lineHeight: 20, marginTop: 6 }]}>
                {report.description}
              </Text>
            </View>
            {(report.photos ?? []).length > 0 ? (
              <View style={{ marginTop: 14 }}>
                <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginBottom: 8 }]}>
                  Photos · {report.photos!.length}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}>
                  {report.photos!.map((p: MaintenanceReportPhoto) => (
                    <View key={p.id}
                      style={{
                        width: 90, height: 90, borderRadius: 10,
                        backgroundColor: "#f1f3f4",
                        alignItems: "center", justifyContent: "center",
                        overflow: "hidden",
                      }}>
                      {p.signedUrl ? (
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        <ImageThumb url={p.signedUrl} />
                      ) : <ImageIcon size={20} color="#9aa0a6" strokeWidth={2} />}
                    </View>
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </ScrollView>

          {/* Actions */}
          <View style={{
            flexDirection: "row", gap: 8,
            paddingHorizontal: 18, paddingTop: 12,
            borderTopWidth: 1, borderTopColor: "#f1f3f4",
          }}>
            <SheetButton
              label="Convert to Action Item"
              color="#1a73e8"
              onPress={() => convertMut.mutate(report.id)}
              disabled={busy}
              primary
            />
            <SheetButton
              label="Dismiss"
              color="#5f6368"
              onPress={() => updateMut.mutate({ id: report.id, status: "dismissed" })}
              disabled={busy}
            />
          </View>
          <View style={{ paddingHorizontal: 18, paddingTop: 8 }}>
            <SheetButton
              label="Delete report"
              color="#b91c1c"
              onPress={() => Alert.alert("Delete?", "This removes the report permanently.", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => deleteMut.mutate(report.id) },
              ])}
              disabled={busy}
              ghost
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Action item detail ─────────────────────────────────────────────────

function ActionItemDetailModal({ item, assetLabel, onClose, onChange }: {
  item: MaintenanceActionItem | null;
  assetLabel: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const updateMut = useMutation({
    mutationFn: (args: { id: string; status?: MaintenanceActionStatus; priority?: MaintenancePriority; outOfService?: boolean }) =>
      railway.updateMaintenanceActionItem(args.id, args),
    onSuccess: () => onChange(),
    onError: (err: Error) => Alert.alert("Update failed", err.message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => railway.deleteMaintenanceActionItem(id),
    onSuccess: () => onChange(),
    onError: (err: Error) => Alert.alert("Delete failed", err.message),
  });

  if (!item) return null;
  const busy = updateMut.isPending || deleteMut.isPending;

  function setStatus(status: MaintenanceActionStatus) {
    if (!item) return;
    updateMut.mutate({ id: item.id, status });
  }
  function setPriority(priority: MaintenancePriority) {
    if (!item) return;
    updateMut.mutate({ id: item.id, priority });
  }
  function toggleOOS() {
    if (!item) return;
    updateMut.mutate({ id: item.id, outOfService: !item.outOfService });
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }}>
        <Pressable onPress={(e) => e.stopPropagation()}
          style={{
            marginTop: "auto", maxHeight: "88%",
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingTop: 10, paddingBottom: 24,
          }}>
          <View style={{ alignItems: "center", paddingVertical: 8 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: "#e8eaed" }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 18, marginBottom: 4 }}>
            <Text style={[txt(800), { fontSize: 18, color: "#202124", flex: 1 }]} numberOfLines={2}>{item.title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={22} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 14 }}>
            <DetailRow label="Asset" value={assetLabel} />
            <DetailRow label="Category" value={item.category} />
            {item.description ? <DetailRow label="Notes" value={item.description} /> : null}
            {item.scheduledDate ? <DetailRow label="Scheduled" value={item.scheduledDate} /> : null}
            {item.completedAt ? <DetailRow label="Completed" value={`${fmtDateTime(item.completedAt)}${item.completedBy ? ` · ${item.completedBy}` : ""}`} /> : null}

            {/* Status segmented control */}
            <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginTop: 18, marginBottom: 8 }]}>Status</Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {(["open", "in_progress", "done"] as MaintenanceActionStatus[]).map(s => {
                const active = item.status === s;
                return (
                  <TouchableOpacity key={s} onPress={() => setStatus(s)} disabled={busy}
                    style={{
                      flex: 1, paddingVertical: 9, borderRadius: 10,
                      backgroundColor: active ? STATUS_COLOR[s] : "#f1f3f4",
                      alignItems: "center",
                      opacity: busy ? 0.6 : 1,
                    }}>
                    <Text style={[txt(700), { fontSize: 12, color: active ? "#fff" : "#3c4043" }]}>
                      {STATUS_LABEL[s]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Priority segmented control */}
            <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginTop: 18, marginBottom: 8 }]}>Priority</Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {(["urgent", "high", "normal", "low"] as MaintenancePriority[]).map(p => {
                const active = item.priority === p;
                return (
                  <TouchableOpacity key={p} onPress={() => setPriority(p)} disabled={busy}
                    style={{
                      flex: 1, paddingVertical: 9, borderRadius: 10,
                      backgroundColor: active ? PRIORITY_COLOR[p] : "#f1f3f4",
                      alignItems: "center",
                      opacity: busy ? 0.6 : 1,
                    }}>
                    <Text style={[txt(700), { fontSize: 11, color: active ? "#fff" : "#3c4043" }]}>
                      {p[0].toUpperCase() + p.slice(1)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* OOS toggle */}
            <TouchableOpacity onPress={toggleOOS} disabled={busy}
              style={{
                marginTop: 18, flexDirection: "row", alignItems: "center", gap: 10,
                paddingVertical: 12, paddingHorizontal: 14,
                borderRadius: 12,
                backgroundColor: item.outOfService ? "#fee2e2" : "#f1f3f4",
                opacity: busy ? 0.6 : 1,
              }}>
              <View style={{
                width: 20, height: 20, borderRadius: 6,
                backgroundColor: item.outOfService ? "#dc2626" : "#fff",
                borderWidth: 1, borderColor: item.outOfService ? "#dc2626" : "#dadce0",
                alignItems: "center", justifyContent: "center",
              }}>
                {item.outOfService ? <Check size={14} color="#fff" strokeWidth={3} /> : null}
              </View>
              <Text style={[txt(700), { fontSize: 14, color: item.outOfService ? "#b91c1c" : "#3c4043", flex: 1 }]}>
                Out of service
              </Text>
            </TouchableOpacity>
          </ScrollView>

          {/* Footer actions */}
          <View style={{
            paddingHorizontal: 18, paddingTop: 10,
            borderTopWidth: 1, borderTopColor: "#f1f3f4",
          }}>
            <SheetButton
              label="Delete action item"
              color="#b91c1c"
              onPress={() => Alert.alert("Delete?", "This removes the action item permanently.", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => deleteMut.mutate(item.id) },
              ])}
              disabled={busy}
              ghost
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Small UI helpers ───────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}>
      <Text style={[txt(700), { fontSize: 11, letterSpacing: 0.8, color: "#5f6368", textTransform: "uppercase" }]}>{label}</Text>
      <Text style={[txt(500), { fontSize: 14, color: "#202124", marginTop: 3 }]}>{value}</Text>
    </View>
  );
}

function SheetButton({ label, color, onPress, disabled, primary, ghost }: {
  label: string; color: string; onPress: () => void;
  disabled?: boolean; primary?: boolean; ghost?: boolean;
}) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled}
      style={{
        flex: 1,
        paddingVertical: 13,
        alignItems: "center",
        borderRadius: 12,
        backgroundColor: ghost ? "transparent" : primary ? color : "#f1f3f4",
        borderWidth: ghost ? 1 : 0,
        borderColor: ghost ? `${color}40` : "transparent",
        opacity: disabled ? 0.55 : 1,
      }}>
      <Text style={[txt(700), {
        fontSize: 13,
        color: primary ? "#fff" : color,
        letterSpacing: 0.2,
      }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// Photo thumb — separate so we can lazy-error without breaking the row.
function ImageThumb({ url }: { url: string }) {
  // Using Image from react-native via require to avoid top-level import
  // cost when there's nothing to render.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Image } = require("react-native");
  return <Image source={{ uri: url }} style={{ width: "100%", height: "100%" }} />;
}

// Unused but exported to silence linters that flag the ChevronUp/Down imports
// reserved for a future inline-edit affordance.
void ChevronUp; void ChevronDown;
