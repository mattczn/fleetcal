/**
 * /maintenance — work orders + driver-submitted reports.
 *
 * Mobile-first take on the web's /equipment → Maintenance tab. Single
 * scrolling surface (no sub-tabs):
 *
 *   1. Open work — the landing surface. Every open / in-progress work
 *      order across the fleet, urgent first, capped with a "view all"
 *      escape into the backlog sheet.
 *   2. Scheduled — the day-nav bar and the items dated to that day.
 *   3. Quick links — focused sheets: backlog, filter, per-asset
 *      history, and the driver-report inbox (pending badge).
 *
 * ── Why "Open work" leads and the day-nav doesn't ─────────────────────
 *
 * This screen used to OPEN on the day-nav, showing only work orders
 * whose scheduledDate matched today. Measured against real usage
 * (Curzon prod, 193 work orders, Mar–Sep 2026) that lands the shop on
 * an empty screen most mornings: 26 of Jordy's 37 completions were
 * closed under an hour after he created them — median five minutes —
 * because he records work AFTER doing it rather than scheduling it
 * ahead. He does set scheduledDate on 60 of 63, but backdated to the
 * day the work actually happened, so "scheduled for today" describes
 * almost nothing he is about to do.
 *
 * What he actually needs on open is "what is still wrong with the
 * fleet" plus a fast way to write down what he just finished — hence
 * the open-work list and the LOG button. The day view is still here,
 * one section down, for whoever is planning rather than recording.
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
  Inbox, CheckCircle2,
} from "lucide-react-native";
import type {
  MaintenanceActionItem, MaintenanceReport,
  Asset, Trailer, Driver,
} from "@fleetcal/types";
import { isMaintenanceReportPending } from "@fleetcal/types";
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
import { AssetHistorySheet, type HistoryTarget } from "@/components/AssetHistorySheet";

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

/** Max open work orders rendered on the landing screen. Curzon carries
 *  ~95 open at a time — a flat list that long is neither scannable nor
 *  cheap to render in a ScrollView, so we show the most urgent slice and
 *  hand the rest to the backlog sheet (which paginates properly). */
const OPEN_PREVIEW_LIMIT = 12;

/** Everything still outstanding across the fleet, most-urgent first.
 *  in_progress sorts above open at equal priority — work someone has
 *  already started is the work most likely to be picked back up. */
function openWork(items: MaintenanceActionItem[]): MaintenanceActionItem[] {
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const statusRank: Record<string, number> = { in_progress: 0, open: 1, done: 2 };
  return items
    .filter((i) => i.status === "open" || i.status === "in_progress")
    .sort((a, b) => {
      const p = priorityRank[a.priority] - priorityRank[b.priority];
      if (p !== 0) return p;
      const s = statusRank[a.status] - statusRank[b.status];
      if (s !== 0) return s;
      // Oldest first within a band — the thing that has been waiting
      // longest should not sink to the bottom of the list.
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
}

function reportsRank(a: MaintenanceReport, b: MaintenanceReport): number {
  // Legacy 'reviewed' ranks with 'dismissed' — same state, so the two
  // don't split into separate bands in the list.
  const rank: Record<string, number> = { open: 0, converted: 1, dismissed: 2, reviewed: 2 };
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
  // "By asset" intermediate picker → AssetHistorySheet
  const [byAssetPickerOpen, setByAssetPickerOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget | null>(null);
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
  const openList      = useMemo(() => openWork(allItems), [allItems]);
  const openPreview   = useMemo(() => openList.slice(0, OPEN_PREVIEW_LIMIT), [openList]);
  const scheduledList = useMemo(() => itemsForDay(allItems, dateKey), [allItems, dateKey]);
  const backlogN      = useMemo(() => backlogCount(allItems), [allItems]);
  const reports       = useMemo(() => [...(reportsQ.data ?? [])].sort(reportsRank), [reportsQ.data]);
  const pendingCount  = useMemo(
    () => (reportsQ.data ?? []).filter((r) => isMaintenanceReportPending(r.status)).length,
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
          {/* LOG is the primary action, not NEW — the shop records
              finished work far more often than it opens a ticket for
              future work. It gets the solid button. */}
          <TouchableOpacity
            onPress={() => setItemSheetMode({ kind: "log", todayKey: todayK })}
            activeOpacity={0.85}
            style={{
              flexDirection: "row", alignItems: "center", gap: 4,
              paddingHorizontal: 12, paddingVertical: 7,
              backgroundColor: "#ffffff", borderRadius: 999,
              marginRight: 8,
            }}
          >
            <CheckCircle2 size={14} color="#1a73e8" strokeWidth={2.6} />
            <Text style={[txt(800), { fontSize: 12, color: "#1a73e8", letterSpacing: 0.3 }]}>
              LOG
            </Text>
          </TouchableOpacity>
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
          <ScrollView
            contentContainerStyle={{ paddingTop: 12, paddingBottom: 120 }}
            refreshControl={
              <RefreshControl refreshing={ordersQ.isFetching} onRefresh={refresh} tintColor="#1a73e8" />
            }
          >
            {/* Open work — the landing surface. See the file header for
                why this leads instead of the day view. */}
            <SectionLabel>OPEN WORK · {openList.length}</SectionLabel>
            {openList.length === 0 ? (
              <View style={{ paddingVertical: 28, alignItems: "center", paddingHorizontal: 32 }}>
                <Text style={[txt(700), { fontSize: 13, color: "#5f6368" }]}>
                  Nothing open.
                </Text>
                <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
                  The whole fleet is clear. Tap LOG to record work you already finished.
                </Text>
              </View>
            ) : (
              <>
                {openPreview.map((it) => (
                  <OrderRow
                    key={it.id}
                    item={it}
                    assets={assets}
                    trailers={trailers}
                    onPress={() => setItemSheetMode({ kind: "edit", item: it })}
                  />
                ))}
                {openList.length > openPreview.length ? (
                  <TouchableOpacity
                    onPress={() => setFilteredSheet({ title: "Backlog", filter: { status: "open" } })}
                    activeOpacity={0.75}
                    style={{
                      marginHorizontal: 14, marginBottom: 8,
                      paddingVertical: 12, borderRadius: 10,
                      alignItems: "center",
                      backgroundColor: "#ffffff",
                      borderWidth: 1, borderColor: "#eef0f2",
                    }}
                  >
                    {/* No count here on purpose. This section counts open
                        + in_progress, but OrdersFilter.status is single-
                        valued, so the backlog sheet can only show one of
                        them — a number here would promise more rows than
                        the sheet delivers. In-progress work sorts to the
                        top of each priority band and is therefore already
                        in the preview above. */}
                    <Text style={[txt(800), { fontSize: 13, color: "#1a73e8" }]}>
                      View full backlog
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </>
            )}

            {/* Scheduled — the planning view, demoted below open work. */}
            <SectionLabel style={{ marginTop: 14 }}>
              SCHEDULED · {scheduledList.length}
            </SectionLabel>
            <DayNav
              dateKey={dateKey}
              todayKey={todayK}
              onShift={shiftDate}
              onJumpToday={() => setDateKey(todayK)}
              onOpenPicker={() => setDatePickerOpen(true)}
            />
            {scheduledList.length === 0 ? (
              <View style={{ paddingVertical: 20, alignItems: "center", paddingHorizontal: 32 }}>
                <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", textAlign: "center" }]}>
                  {dateKey === todayK
                    ? "Nothing dated today."
                    : "Nothing dated this day."}
                </Text>
              </View>
            ) : (
              <View style={{ paddingTop: 8 }}>
                {scheduledList.map((it) => (
                  <OrderRow
                    key={it.id}
                    item={it}
                    assets={assets}
                    trailers={trailers}
                    onPress={() => setItemSheetMode({ kind: "edit", item: it })}
                  />
                ))}
              </View>
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
              label="Asset history"
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
        hint="Open work, completed history, and driver reports for this truck."
        assets={assets}
        onClose={() => setByAssetPickerOpen(false)}
        onSelect={(a) => {
          setByAssetPickerOpen(false);
          setTimeout(() => setHistoryTarget({ kind: "asset", asset: a }), 200);
        }}
      />
      <AssetHistorySheet
        visible={historyTarget != null}
        target={historyTarget}
        items={allItems}
        reports={reports}
        drivers={drivers}
        onClose={() => setHistoryTarget(null)}
        onOpenItem={(item) => {
          setHistoryTarget(null);
          setTimeout(() => setItemSheetMode({ kind: "edit", item }), 200);
        }}
        onOpenReport={(r) => {
          setHistoryTarget(null);
          setTimeout(() => setActiveReport(r), 200);
        }}
        onNewForTarget={() => {
          // The item sheet has no "preselect equipment" mode yet, so this
          // opens a blank work order and the user picks the truck. Worth
          // seeding once the sheet grows a defaults param.
          setHistoryTarget(null);
          setTimeout(() => setItemSheetMode({ kind: "create" }), 200);
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

