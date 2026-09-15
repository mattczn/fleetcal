/**
 * Per-asset history sheet — "what has happened to this truck?"
 *
 * Mobile counterpart to the web's Equipment → History tab
 * (TruckHistoryBody in apps/web/app/equipment/page.tsx). Web fans out to
 * four sources; this covers the two that matter standing next to the
 * truck:
 *
 *   1. Open work  — open + in_progress work orders. What is wrong with
 *                   it right now.
 *   2. History    — completed work orders, newest first. What has
 *                   already been done, so the same repair doesn't get
 *                   written up twice.
 *   3. Driver reports — defects the drivers filed against this unit,
 *                   open ones first.
 *
 * NOT included (yet): inspection defects and recent drivers. Both exist
 * on web; the dispatch API client has no listInspectionReports binding
 * and the asset timeline is a separate endpoint, so they're a follow-up
 * rather than a silent omission.
 *
 * Everything is filtered from lists the maintenance screen has ALREADY
 * fetched — opening history costs no network round-trip, which matters
 * in a shop with bad signal.
 */
import React, { useMemo } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, SectionList,
} from "react-native";
import { X, Truck, Container, Wrench, Inbox, CircleCheck } from "lucide-react-native";
import type {
  MaintenanceActionItem, MaintenanceReport,
  Asset, Trailer, Driver,
} from "@fleetcal/types";
import { txt } from "@/lib/font";
import {
  StatusPill, ReportStatusPill, PRIORITY_COLORS,
  fmtCost, fmtScheduledDate,
} from "@/lib/maintenanceUI";

/** Which piece of equipment the sheet is showing. */
export type HistoryTarget =
  | { kind: "asset";   asset: Asset }
  | { kind: "trailer"; trailer: Trailer };

interface Props {
  visible: boolean;
  target:  HistoryTarget | null;
  /** Full work-order + report lists from the parent screen. Filtered here. */
  items:   MaintenanceActionItem[];
  reports: MaintenanceReport[];
  drivers: Driver[];
  onClose: () => void;
  /** Open a work order in the edit sheet. */
  onOpenItem:   (item: MaintenanceActionItem) => void;
  /** Open a driver report in the report sheet (convert / dismiss). */
  onOpenReport: (report: MaintenanceReport) => void;
  /** Start a new work order already pointed at this equipment. */
  onNewForTarget: (target: HistoryTarget) => void;
}

type Row =
  | { kind: "item";   item: MaintenanceActionItem }
  | { kind: "report"; report: MaintenanceReport };

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function AssetHistorySheet({
  visible, target, items, reports, drivers,
  onClose, onOpenItem, onOpenReport, onNewForTarget,
}: Props) {
  const label = target
    ? target.kind === "asset"
      ? target.asset.name
      : (target.trailer.trailerNumber ? `Trailer ${target.trailer.trailerNumber}` : target.trailer.name)
    : "";

  const sections = useMemo(() => {
    if (!target) return [];
    const isAsset  = target.kind === "asset";
    const targetId = isAsset ? target.asset.id : target.trailer.id;

    const mine = items.filter((i) =>
      isAsset ? i.assetId === targetId : i.trailerId === targetId);

    const open = mine
      .filter((i) => i.status === "open" || i.status === "in_progress")
      .sort((a, b) => {
        const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (p !== 0) return p;
        return (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? "");
      });

    // Completed work, newest first. completedAt is the honest timestamp;
    // scheduledDate is what the shop backdates, so fall back through both
    // before giving up and using creation order.
    const done = mine
      .filter((i) => i.status === "done")
      .sort((a, b) => {
        const ka = a.completedAt ?? a.scheduledDate ?? a.createdAt ?? "";
        const kb = b.completedAt ?? b.scheduledDate ?? b.createdAt ?? "";
        return kb.localeCompare(ka);
      });

    const mineReports = reports
      .filter((r) => isAsset ? r.assetId === targetId : r.trailerId === targetId)
      .sort((a, b) => {
        const rank: Record<string, number> = { open: 0, converted: 1, dismissed: 2, reviewed: 2 };
        const d = rank[a.status] - rank[b.status];
        if (d !== 0) return d;
        return b.reportedAt.localeCompare(a.reportedAt);
      });

    const out: Array<{ title: string; count: number; data: Row[] }> = [];
    out.push({ title: "OPEN WORK", count: open.length, data: open.map((item) => ({ kind: "item" as const, item })) });
    out.push({ title: "COMPLETED", count: done.length, data: done.map((item) => ({ kind: "item" as const, item })) });
    out.push({ title: "DRIVER REPORTS", count: mineReports.length, data: mineReports.map((report) => ({ kind: "report" as const, report })) });
    return out;
  }, [target, items, reports]);

  const Icon = target?.kind === "trailer" ? Container : Truck;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#f8f9fa",
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
            maxHeight: "88%", paddingBottom: 24,
          }}
        >
          {/* Header */}
          <View style={{
            flexDirection: "row", alignItems: "center", gap: 10,
            paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12,
            borderBottomWidth: 1, borderBottomColor: "#e8eaed",
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 18, borderTopRightRadius: 18,
          }}>
            <Icon size={18} color="#1a73e8" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 17, color: "#202124", flex: 1 }]} numberOfLines={1}>
              {label}
            </Text>
            <TouchableOpacity
              onPress={() => { if (target) onNewForTarget(target); }}
              activeOpacity={0.8}
              style={{
                paddingHorizontal: 12, paddingVertical: 7,
                backgroundColor: "#e8f0fe", borderRadius: 999,
              }}
            >
              <Text style={[txt(800), { fontSize: 11, color: "#1967d2", letterSpacing: 0.3 }]}>
                NEW
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          <SectionList
            sections={sections}
            keyExtractor={(row) => row.kind === "item" ? `i:${row.item.id}` : `r:${row.report.id}`}
            contentContainerStyle={{ paddingBottom: 40 }}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => (
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 6,
                paddingHorizontal: 14, paddingTop: 16, paddingBottom: 6,
              }}>
                {section.title === "OPEN WORK" ? <Wrench size={12} color="#5f6368" strokeWidth={2.4} />
                  : section.title === "COMPLETED" ? <CircleCheck size={12} color="#5f6368" strokeWidth={2.4} />
                  : <Inbox size={12} color="#5f6368" strokeWidth={2.4} />}
                <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 0.6 }]}>
                  {section.title} · {section.count}
                </Text>
              </View>
            )}
            renderSectionFooter={({ section }) => (
              section.count === 0 ? (
                <Text style={[txt(500), {
                  fontSize: 12, color: "#9aa0a6",
                  paddingHorizontal: 16, paddingVertical: 6,
                }]}>
                  {section.title === "OPEN WORK" ? "Nothing open on this unit."
                    : section.title === "COMPLETED" ? "No completed work recorded yet."
                    : "No driver reports for this unit."}
                </Text>
              ) : null
            )}
            renderItem={({ item: row }) =>
              row.kind === "item"
                ? <HistoryItemRow item={row.item} onPress={() => onOpenItem(row.item)} />
                : <HistoryReportRow report={row.report} drivers={drivers} onPress={() => onOpenReport(row.report)} />
            }
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function HistoryItemRow({
  item, onPress,
}: {
  item: MaintenanceActionItem;
  onPress: () => void;
}) {
  const priority = PRIORITY_COLORS[item.priority];
  const cost = fmtCost(item.actualCost);
  const when = fmtScheduledDate(item.scheduledDate);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        flexDirection: "row",
        backgroundColor: "#ffffff",
        marginHorizontal: 14, marginBottom: 8,
        borderRadius: 10,
        borderWidth: 1, borderColor: "#eef0f2",
        overflow: "hidden",
      }}
    >
      <View style={{ width: 4, backgroundColor: priority.stripe }} />
      <View style={{ flex: 1, padding: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[txt(800), { fontSize: 14, color: "#202124", flex: 1 }]} numberOfLines={2}>
            {item.title}
          </Text>
          <StatusPill status={item.status} />
        </View>
        {(when || cost) ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
            {when ? (
              <Text style={[txt(600), { fontSize: 11, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
                {when}
              </Text>
            ) : <View style={{ flex: 1 }} />}
            {cost ? (
              <Text style={[txt(800), { fontSize: 11, color: "#15803d" }]}>{cost}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function HistoryReportRow({
  report, drivers, onPress,
}: {
  report: MaintenanceReport;
  drivers: Driver[];
  onPress: () => void;
}) {
  const driver = drivers.find((d) => d.id === report.driverId);
  const when = new Date(report.reportedAt)
    .toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        backgroundColor: "#ffffff",
        marginHorizontal: 14, marginBottom: 8,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1, borderColor: "#eef0f2",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[txt(700), { fontSize: 12, color: "#3c4043", flex: 1 }]} numberOfLines={1}>
          {driver?.name ?? "Driver"} · {when}
        </Text>
        <ReportStatusPill status={report.status} />
      </View>
      <Text style={[txt(500), { fontSize: 13, color: "#202124", marginTop: 4 }]} numberOfLines={3}>
        {report.description}
      </Text>
    </TouchableOpacity>
  );
}
