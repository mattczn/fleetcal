/**
 * /maintenance — work orders + driver-submitted reports.
 *
 * Mobile-first take on the web's /equipment → Maintenance tab. Single
 * scrolling surface (no sub-tabs):
 *
 *   1. Day-nav bar (< [Today · Fri May 29] > [Today]) — the primary
 *      scheduling surface. Shows ONLY items whose scheduledDate matches
 *      the selected day, regardless of status.
 *   2. Scheduled list — simple work-order cards for that day. Empty
 *      state when the day is clear.
 *   3. Quick links — four buttons that each open a focused sheet:
 *        · View backlog (FilteredOrdersSheet, status: open)
 *        · Filter (FilteredOrdersSheet, user touches chips)
 *        · By asset (asset picker → FilteredOrdersSheet for that asset)
 *        · Driver reports (MaintenanceReportsListSheet, pending badge)
 */
import React, { useMemo, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, FlatList, ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrganization } from "@clerk/clerk-expo";
import {
  Plus, Truck, Container, Wrench, ChevronLeft, ChevronRight,
  CalendarCheck, Calendar as CalendarIcon,
  Archive, Filter as FilterIcon, ChevronRight as ChevronRightSm,
  Inbox,
} from "lucide-react-native";
import type {
  MaintenanceActionItem, MaintenanceReport,
  Asset, Trailer, Driver,
} from "@fleetcal/types";
import { txt } from "@/lib/font";
import { railway } from "@/lib/railway";
import { fetchAssets, fetchTrailers, fetchDrivers } from "@/lib/api";
import {
  StatusPill, PRIORITY_COLORS,
  fmtCost, fmtScheduledDate,
} from "@/lib/maintenanceUI";
import { useOrgTimezone, todayKeyInTz, todayKeyDeviceLocal } from "@/lib/timezone";
import { MaintenanceItemSheet, ItemSheetMode } from "@/components/MaintenanceItemSheet";
import { MaintenanceReportSheet } from "@/components/MaintenanceReportSheet";
import { MaintenanceReportsListSheet } from "@/components/MaintenanceReportsListSheet";
import { FilteredOrdersSheet, OrdersFilter } from "@/components/FilteredOrdersSheet";
import { DatePickerModal } from "@/components/DatePickerModal";
import { AssetPickerSheet } from "@/components/AssetPickerSheet";

// ── Helpers ───────────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, "0"); }

function shiftKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDayLabel(dateKey: string, todayKey: string): string {
  const d = new Date(`${dateKey}T12:00:00`);
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (dateKey === todayKey)                return `Today · ${date}`;
  if (dateKey === shiftKey(todayKey, 1))   return `Tomorrow · ${date}`;
  if (dateKey === shiftKey(todayKey, -1))  return `Yesterday · ${date}`;
  return date;
}

/** Items to display for the selected day — ONLY items whose
 *  scheduledDate matches `dayKey`. We deliberately don't auto-promote
 *  in-progress items into today's view; the day list mirrors the
 *  maintenance calendar, not "what is brother actively working on
 *  right now." In-progress work that's scheduled elsewhere is still
 *  visible via the backlog / filter quick links. */
function itemsForDay(
  items: MaintenanceActionItem[],
  dayKey: string,
): MaintenanceActionItem[] {
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const statusRank: Record<string, number> = { in_progress: 0, open: 1, done: 2 };
  return items
    .filter((i) => i.scheduledDate === dayKey)
    .sort((a, b) => {
      const s = statusRank[a.status] - statusRank[b.status];
      if (s !== 0) return s;
      const p = priorityRank[a.priority] - priorityRank[b.priority];
      if (p !== 0) return p;
      return a.title.localeCompare(b.title);
    });
}

function backlogCount(items: MaintenanceActionItem[]): number {
  return items.filter((i) => i.status === "open").length;
}

function reportsRank(a: MaintenanceReport, b: MaintenanceReport): number {
  const rank: Record<string, number> = { open: 0, reviewed: 1, converted: 2, dismissed: 3 };
  const r = rank[a.status] - rank[b.status];
  if (r !== 0) return r;
  return b.reportedAt.localeCompare(a.reportedAt);
}

// ── Sub-components ────────────────────────────────────────────────────

function DayNav({
  dateKey, todayKey, onShift, onJumpToday, onOpenPicker,
}: {
  dateKey:      string;
  todayKey:     string;
  onShift:      (days: number) => void;
  onJumpToday:  () => void;
  onOpenPicker: () => void;
}) {
  const isToday = dateKey === todayKey;
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 8,
      paddingHorizontal: 14, paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: "#e8eaed",
      backgroundColor: "#ffffff",
    }}>
      <TouchableOpacity
        onPress={() => onShift(-1)}
        hitSlop={8}
        style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: "#f1f3f4",
          alignItems: "center", justifyContent: "center",
        }}
      >
        <ChevronLeft size={16} color="#3c4043" strokeWidth={2.4} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onOpenPicker}
        activeOpacity={0.7}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <Text style={[txt(800), { fontSize: 15, color: "#202124", flex: 1 }]} numberOfLines={1}>
          {fmtDayLabel(dateKey, todayKey)}
        </Text>
        <CalendarIcon size={13} color="#5f6368" strokeWidth={2.2} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => onShift(1)}
        hitSlop={8}
        style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: "#f1f3f4",
          alignItems: "center", justifyContent: "center",
        }}
      >
        <ChevronRight size={16} color="#3c4043" strokeWidth={2.4} />
      </TouchableOpacity>
      {!isToday ? (
        <TouchableOpacity
          onPress={onJumpToday}
          style={{
            flexDirection: "row", alignItems: "center", gap: 4,
            paddingHorizontal: 10, paddingVertical: 7,
            backgroundColor: "#e8f0fe", borderRadius: 999,
          }}
        >
          <CalendarCheck size={12} color="#1967d2" strokeWidth={2.4} />
          <Text style={[txt(800), { fontSize: 11, color: "#1967d2", letterSpacing: 0.3 }]}>
            TODAY
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function OrderRow({
  item, assets, trailers, onPress,
}: {
  item: MaintenanceActionItem;
  assets: Asset[]; trailers: Trailer[];
  onPress: () => void;
}) {
  const priority = PRIORITY_COLORS[item.priority];
  const asset    = item.assetId   ? assets.find((a) => a.id === item.assetId)     : null;
  const trailer  = item.trailerId ? trailers.find((t) => t.id === item.trailerId) : null;
  const equipmentLabel = asset
    ? asset.name
    : trailer
      ? (trailer.trailerNumber ? `Trailer ${trailer.trailerNumber}` : trailer.name)
      : "—";
  const Icon = trailer ? Container : Truck;
  const cost = fmtCost(item.actualCost);

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
          <Text style={[txt(800), { fontSize: 14, color: "#202124", flex: 1 }]} numberOfLines={1}>
            {item.title}
          </Text>
          <StatusPill status={item.status} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
          <Icon size={12} color="#5f6368" strokeWidth={2.2} />
          <Text style={[txt(600), { fontSize: 12, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
            {equipmentLabel}
          </Text>
        </View>
        {(item.vendor || cost) ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 3 }}>
            {item.vendor ? (
              <Text style={[txt(600), { fontSize: 11, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
                {item.vendor}
              </Text>
            ) : <View style={{ flex: 1 }} />}
            {cost ? (
              <Text style={[txt(800), { fontSize: 11, color: "#15803d" }]}>
                {cost}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function QuickLinkRow({
  icon, label, count, onPress,
}: {
  icon:   React.ReactNode;
  label:  string;
  count?: number;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        flexDirection: "row", alignItems: "center", gap: 12,
        backgroundColor: "#ffffff",
        marginHorizontal: 14, marginBottom: 8,
        paddingHorizontal: 14, paddingVertical: 14,
        borderRadius: 10,
        borderWidth: 1, borderColor: "#eef0f2",
      }}
    >
      <View style={{
        width: 36, height: 36, borderRadius: 10,
        backgroundColor: "#e8f0fe",
        alignItems: "center", justifyContent: "center",
      }}>
        {icon}
      </View>
      <Text style={[txt(800), { fontSize: 14, color: "#202124", flex: 1 }]}>
        {label}
      </Text>
      {count != null && count > 0 ? (
        <View style={{
          minWidth: 22, height: 22, paddingHorizontal: 7, borderRadius: 11,
          backgroundColor: "#f1f3f4",
          alignItems: "center", justifyContent: "center",
        }}>
          <Text style={[txt(800), { fontSize: 11, color: "#3c4043" }]}>{count}</Text>
        </View>
      ) : null}
      <ChevronRightSm size={16} color="#9aa0a6" strokeWidth={2.2} />
    </TouchableOpacity>
  );
}

// (Inline ReportRow / TabButton helpers were removed in v3 — Reports
//  moved to a quick-link sheet that brings its own row component, and
//  the Orders/Reports sub-tab toggle is gone.)

// ── Screen ────────────────────────────────────────────────────────────

export default function MaintenanceScreen() {
  const insets = useSafeAreaInsets();
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const qc = useQueryClient();
  const { tz: orgTz } = useOrgTimezone();

  const todayK = orgTz ? todayKeyInTz(orgTz) : todayKeyDeviceLocal();
  const [dateKey, setDateKey] = useState<string>(todayK);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // One-shot snap to org-today once TZ resolves (mirrors the calendar
  // tab's pattern — see calendar.tsx).
  const tzSnappedRef = React.useRef(false);
  React.useEffect(() => {
    if (tzSnappedRef.current || !orgTz) return;
    const orgToday    = todayKeyInTz(orgTz);
    const deviceToday = todayKeyDeviceLocal();
    if (dateKey === deviceToday && deviceToday !== orgToday) setDateKey(orgToday);
    tzSnappedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgTz]);

  // ── Sheets state ────────────────────────────────────────────────────
  const [itemSheetMode, setItemSheetMode] = useState<ItemSheetMode | null>(null);
  const [activeReport,  setActiveReport]  = useState<MaintenanceReport | null>(null);
  // Filtered list sheet — used by the first three quick links.
  const [filteredSheet, setFilteredSheet] = useState<{
    title:   string;
    filter:  OrdersFilter;
  } | null>(null);
  // "By asset" intermediate picker
  const [byAssetPickerOpen, setByAssetPickerOpen] = useState(false);
  // Reports-list sheet — opened by the fourth quick-link button.
  const [reportsListOpen, setReportsListOpen] = useState(false);

  // ── Data ────────────────────────────────────────────────────────────
  const { data: assets   = [] } = useQuery({ queryKey: ["assets", orgId],   queryFn: () => fetchAssets(orgId!),   enabled: !!orgId, staleTime: 5 * 60 * 1000 });
  const { data: trailers = [] } = useQuery({ queryKey: ["trailers", orgId], queryFn: () => fetchTrailers(orgId!), enabled: !!orgId, staleTime: 5 * 60 * 1000 });
  const { data: drivers  = [] } = useQuery({ queryKey: ["drivers", orgId],  queryFn: () => fetchDrivers(orgId!),  enabled: !!orgId, staleTime: 5 * 60 * 1000 });

  const ordersQ = useQuery({
    queryKey: ["maintenance-action-items", orgId],
    queryFn:  async () => {
      const { actionItems } = await railway.listMaintenanceActionItems({ limit: 500 });
      return actionItems;
    },
    enabled: !!orgId,
  });

  const reportsQ = useQuery({
    queryKey: ["maintenance-reports", orgId],
    queryFn:  async () => {
      const { reports } = await railway.listMaintenanceReports({ limit: 200 });
      return reports;
    },
    enabled: !!orgId,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["maintenance-action-items"] });
    qc.invalidateQueries({ queryKey: ["maintenance-reports"] });
  };

  // ── Derived ─────────────────────────────────────────────────────────
  const allItems      = ordersQ.data ?? [];
  const scheduledList = useMemo(() => itemsForDay(allItems, dateKey), [allItems, dateKey]);
  const backlogN      = useMemo(() => backlogCount(allItems), [allItems]);
  const reports       = useMemo(() => [...(reportsQ.data ?? [])].sort(reportsRank), [reportsQ.data]);
  const pendingCount  = useMemo(
    () => (reportsQ.data ?? []).filter((r) => r.status === "open" || r.status === "reviewed").length,
    [reportsQ.data],
  );

  const loading = ordersQ.isLoading || reportsQ.isLoading;

  // ── Render ──────────────────────────────────────────────────────────
  if (!orgId) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: insets.top + 24 }}>
        <Text style={[txt(700), { color: "#5f6368" }]}>No organization selected.</Text>
      </View>
    );
  }

  function shiftDate(days: number) { setDateKey((k) => shiftKey(k, days)); }

  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {/* Header */}
      <View style={{ backgroundColor: "#1a73e8", paddingHorizontal: 16, paddingTop: insets.top + 8, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[txt(800), { fontSize: 22, color: "#ffffff", flex: 1, letterSpacing: -0.3 }]}>
            Maintenance
          </Text>
          <TouchableOpacity
            onPress={() => setItemSheetMode({ kind: "create" })}
            activeOpacity={0.85}
            style={{
              flexDirection: "row", alignItems: "center", gap: 4,
              paddingHorizontal: 12, paddingVertical: 7,
              backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 999,
            }}
          >
            <Plus size={14} color="#ffffff" strokeWidth={2.6} />
            <Text style={[txt(800), { fontSize: 12, color: "#ffffff", letterSpacing: 0.3 }]}>
              NEW
            </Text>
          </TouchableOpacity>
        </View>

      </View>

      {/* Body */}
      {loading && (ordersQ.data == null || reportsQ.data == null) ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color="#1a73e8" />
        </View>
      ) : (
        <>
          <DayNav
            dateKey={dateKey}
            todayKey={todayK}
            onShift={shiftDate}
            onJumpToday={() => setDateKey(todayK)}
            onOpenPicker={() => setDatePickerOpen(true)}
          />
          <ScrollView
            contentContainerStyle={{ paddingTop: 12, paddingBottom: 120 }}
            refreshControl={
              <RefreshControl refreshing={ordersQ.isFetching} onRefresh={refresh} tintColor="#1a73e8" />
            }
          >
            {/* Scheduled list */}
            <SectionLabel>
              {dateKey === todayK ? "TODAY" : "SCHEDULED"} · {scheduledList.length}
            </SectionLabel>
            {scheduledList.length === 0 ? (
              <View style={{ paddingVertical: 28, alignItems: "center", paddingHorizontal: 32 }}>
                <Text style={[txt(700), { fontSize: 13, color: "#5f6368" }]}>
                  Nothing scheduled.
                </Text>
                <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
                  {dateKey === todayK
                    ? "Browse the backlog below or step forward to plan."
                    : "Step back to Today or jump via the calendar."}
                </Text>
              </View>
            ) : (
              scheduledList.map((it) => (
                <OrderRow
                  key={it.id}
                  item={it}
                  assets={assets}
                  trailers={trailers}
                  onPress={() => setItemSheetMode({ kind: "edit", item: it })}
                />
              ))
            )}

            {/* Quick links */}
            <SectionLabel style={{ marginTop: 14 }}>QUICK LINKS</SectionLabel>
            <QuickLinkRow
              icon={<Archive size={18} color="#1967d2" strokeWidth={2.2} />}
              label="View backlog"
              count={backlogN}
              onPress={() => setFilteredSheet({
                title: "Backlog",
                filter: { status: "open" },
              })}
            />
            <QuickLinkRow
              icon={<FilterIcon size={18} color="#1967d2" strokeWidth={2.2} />}
              label="Filter by priority, truck, or trailer"
              onPress={() => setFilteredSheet({
                title: "Filter Work Orders",
                filter: { status: "open" },
              })}
            />
            <QuickLinkRow
              icon={<Truck size={18} color="#1967d2" strokeWidth={2.2} />}
              label="View by asset"
              onPress={() => setByAssetPickerOpen(true)}
            />
            <QuickLinkRow
              icon={<Inbox size={18} color="#1967d2" strokeWidth={2.2} />}
              label="View driver maintenance reports"
              count={pendingCount > 0 ? pendingCount : undefined}
              onPress={() => setReportsListOpen(true)}
            />
          </ScrollView>
        </>
      )}

      {/* Sheets */}
      <MaintenanceItemSheet
        visible={itemSheetMode != null}
        mode={itemSheetMode ?? { kind: "create" }}
        assets={assets}
        trailers={trailers}
        orgId={orgId}
        onClose={() => setItemSheetMode(null)}
        onMutated={refresh}
      />
      <MaintenanceReportSheet
        visible={activeReport != null}
        report={activeReport}
        assets={assets}
        trailers={trailers}
        drivers={drivers}
        onClose={() => setActiveReport(null)}
        onMutated={refresh}
        onConvert={(r) => {
          setActiveReport(null);
          setTimeout(() => setItemSheetMode({ kind: "convert", report: r }), 200);
        }}
      />
      <FilteredOrdersSheet
        visible={filteredSheet != null}
        title={filteredSheet?.title ?? ""}
        initialFilter={filteredSheet?.filter ?? {}}
        items={allItems}
        assets={assets}
        trailers={trailers}
        orgId={orgId}
        onClose={() => setFilteredSheet(null)}
        onOpenItem={(item) => {
          setFilteredSheet(null);
          setTimeout(() => setItemSheetMode({ kind: "edit", item }), 200);
        }}
      />
      <AssetPickerSheet
        visible={byAssetPickerOpen}
        title="Which asset?"
        hint="Show all work orders for this truck."
        assets={assets}
        onClose={() => setByAssetPickerOpen(false)}
        onSelect={(a) => {
          setByAssetPickerOpen(false);
          setTimeout(() => setFilteredSheet({
            title: a.name,
            filter: { assetId: a.id, status: "open" },
          }), 200);
        }}
      />
      <DatePickerModal
        visible={datePickerOpen}
        selected={dateKey}
        onClose={() => setDatePickerOpen(false)}
        onSelect={(d) => { setDateKey(d); setDatePickerOpen(false); }}
      />
      <MaintenanceReportsListSheet
        visible={reportsListOpen}
        reports={reports}
        drivers={drivers}
        assets={assets}
        trailers={trailers}
        refreshing={reportsQ.isFetching}
        onClose={() => setReportsListOpen(false)}
        onRefresh={refresh}
        onOpenReport={(r) => {
          setReportsListOpen(false);
          // Modal-on-modal: let the list close before the detail opens.
          setTimeout(() => setActiveReport(r), 200);
        }}
      />
    </View>
  );
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: object }) {
  return (
    <Text style={[txt(800), {
      fontSize: 11, color: "#5f6368", letterSpacing: 0.6,
      paddingHorizontal: 14, paddingVertical: 6,
    }, style]}>
      {children}
    </Text>
  );
}

