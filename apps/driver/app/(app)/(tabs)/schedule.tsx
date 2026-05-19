import React, { useEffect, useMemo } from "react";
import {
  View, Text, SectionList, TouchableOpacity, ActivityIndicator, RefreshControl, ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Calendar, MapPin, CalendarCheck, Truck, CalendarDays, List } from "lucide-react-native";
import { fetchLoadsForDriver, fetchLoad } from "@/lib/api/loads";
import { EmptyState } from "@/components/EmptyState";
import { DayView, type DayViewHandle } from "@/components/DayView";
import { useDriverSession } from "@/lib/useDriverSession";
import { needsConfirmation } from "@/lib/loadStatus";
import { useLoadsRealtime } from "@/lib/useLoadsRealtime";
import { usePushRegistration } from "@/lib/usePushRegistration";
import {
  RelayChip, NonRevChip, StatusPill, DiagonalStripes,
  fmtTimeRangeShort, loadNumLabel,
} from "@/lib/loadCard";
import { useOrgTz, todayKeyInTz } from "@/lib/orgTz";
import type { Load } from "@/lib/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

function dateKeyOf(iso: string): string { return iso.slice(0, 10); }

/** Shift a "YYYY-MM-DD" key by N days. Noon anchor avoids DST edge cases. */
function shiftDateKey(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Section header for a day. `todayKey` must be in the org's tz — pass
 *  in from the caller (uses todayKeyInTz(orgTz)) so "Today" / "Tomorrow"
 *  / "Yesterday" reflect the org's calendar day, not the device's. */
function fmtDateHeader(dateStr: string, todayKey: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  const todayD = new Date(`${todayKey}T12:00:00`);
  const dateLabel = d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    year: todayD.getFullYear() !== d.getFullYear() ? "numeric" : undefined,
  });
  if (dateStr === todayKey)                   return `Today · ${dateLabel}`;
  if (dateStr === shiftDateKey(todayKey,  1)) return `Tomorrow · ${dateLabel}`;
  if (dateStr === shiftDateKey(todayKey, -1)) return `Yesterday · ${dateLabel}`;
  return dateLabel;
}

// First / last stop of the driver's leg — handles relays (where the
// type lookup misses the relay handoff). Mirrors the LoadCard helper.
function originStop(load: Load) { return load.stops[0]; }
function destinationStop(load: Load) { return load.stops[load.stops.length - 1]; }

function locLabel(s: Load["stops"][number] | undefined): string {
  if (!s) return "—";
  if (s.city && s.state) return `${s.city}, ${s.state}`;
  return s.city ?? s.facilityName ?? s.address ?? "—";
}

interface DayEntry {
  load:      Load;
  dayIndex:  number;   // 1-based
  totalDays: number;
}

function ScheduleCard({ entry }: { entry: DayEntry }) {
  const router = useRouter();
  const { load, dayIndex, totalDays } = entry;
  const pickup   = originStop(load);
  const delivery = destinationStop(load);
  const isMulti  = totalDays > 1;
  const needsAction = needsConfirmation(load);
  const isNonRev   = load.eventKind === "non_revenue";

  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: load.id } })}
      activeOpacity={0.85}
      style={{
        flexDirection: "row",
        backgroundColor: "#ffffff",
        borderRadius: 12,
        marginBottom: 8,
        marginHorizontal: 16,
        overflow: "hidden",
        borderWidth: 1, borderColor: "#e8eaed",
      }}
    >
      <View style={{ width: 4, backgroundColor: needsAction ? "#dc2626" : "#1a73e8" }} />

      <View style={{ flex: 1, padding: 12 }}>
        {isNonRev ? <DiagonalStripes /> : null}

        {/* Title row — title + relay/non-rev chips */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={[txt(800), { fontSize: 15, color: "#202124", flex: 1 }]} numberOfLines={1}>
            {load.title}
          </Text>
          {isNonRev ? <NonRevChip size="small" /> : null}
          {load.relayRole ? <RelayChip role={load.relayRole} size="small" /> : null}
        </View>

        {/* Equipment row */}
        {(load.assetName || load.trailerType) ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 }}>
            {load.assetName ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Truck size={11} color="#5f6368" strokeWidth={2.2} />
                <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]} numberOfLines={1}>
                  {load.assetName}
                </Text>
              </View>
            ) : null}
            {load.trailerType ? (
              <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]} numberOfLines={1}>
                · {load.trailerType}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Route */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 }}>
          <MapPin size={11} color="#5f6368" strokeWidth={2.2} />
          <Text style={[txt(600), { fontSize: 12, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
            {locLabel(pickup)}
            {"  →  "}
            {locLabel(delivery)}
          </Text>
        </View>

        {/* Meta row — load # · time range · [status] · multi-day chip */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
          <Text style={[txt(700), { fontSize: 11, color: "#1a73e8" }]} numberOfLines={1}>
            {loadNumLabel(load)}
          </Text>
          <Text style={[txt(600), { fontSize: 11, color: "#9aa0a6" }]}>·</Text>
          <Text style={[txt(600), { fontSize: 11, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
            {fmtTimeRangeShort(load)}
          </Text>
          <StatusPill status={load.status} size="small" />
          {isMulti ? (
            <View style={{ paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, backgroundColor: "#e8f0fe" }}>
              <Text style={[txt(800), { fontSize: 9, color: "#1558d6", letterSpacing: 0.3 }]}>
                DAY {dayIndex}/{totalDays}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function ScheduleScreen() {
  const session = useDriverSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<"schedule" | "day">("schedule");
  const dayViewRef = React.useRef<DayViewHandle>(null);
  const driver = session.status === "matched" ? session.driver : null;
  useLoadsRealtime(driver?.driverId, driver?.orgId);
  usePushRegistration(driver?.driverId, driver?.orgId);

  const { data: loads, isLoading, isRefetching, refetch, isError } = useQuery({
    queryKey: ["loads", driver?.driverId],
    queryFn:  () => fetchLoadsForDriver(driver!.driverId, driver!.orgId),
    enabled:  !!driver,
  });

  // Pre-fetch full details for every load whose time window touches the
  // ±24h band. The list endpoint already returns enough to render cards,
  // but the load-detail screen issues a separate fetchLoad on tap — and
  // that one won't hit the network if the driver is offline. Prefetching
  // here seeds ['load', id] in the persisted cache so airplane-mode tap
  // lands on the full detail view, not a spinner.
  useEffect(() => {
    if (!loads || !driver) return;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const active = loads.filter((l) => {
      const start = new Date(l.start).getTime();
      const end   = new Date(l.end).getTime();
      // Window touches [now - 24h, now + 24h]
      return end >= now - DAY && start <= now + DAY;
    });
    for (const l of active) {
      void queryClient.prefetchQuery({
        queryKey: ["load", l.id],
        queryFn:  () => fetchLoad(l.id, driver.driverId, driver.orgId),
      });
    }
  }, [loads, driver, queryClient]);

  // "Today" must be in the org's tz — otherwise the count and the
  // Today/Tomorrow/Yesterday section labels are based on the device's
  // calendar day, which is wrong when the driver is in a different
  // zone than the org. orgTz comes from the server (/v1/driver/org-settings).
  const orgTz = useOrgTz(driver?.driverId, driver?.orgId);
  const todayKey = todayKeyInTz(orgTz);

  const upcomingCount = useMemo(() => {
    if (!loads) return 0;
    // A load counts if its end date is today or later (i.e. not fully in the past)
    return loads.filter((l) => l.end.slice(0, 10) >= todayKey).length;
  }, [loads, todayKey]);

  const sections = useMemo(() => {
    if (!loads) return [];
    const groups = new Map<string, DayEntry[]>();

    for (const load of loads) {
      const startKey = dateKeyOf(load.start);
      const endKey   = dateKeyOf(load.end);
      // Build the inclusive list of date keys this load spans
      const dayKeys: string[] = [];
      const cur = new Date(`${startKey}T00:00:00`);
      const end = new Date(`${endKey}T00:00:00`);
      while (cur.getTime() <= end.getTime()) {
        const yyyy = cur.getFullYear();
        const mm   = String(cur.getMonth() + 1).padStart(2, "0");
        const dd   = String(cur.getDate()).padStart(2, "0");
        dayKeys.push(`${yyyy}-${mm}-${dd}`);
        cur.setDate(cur.getDate() + 1);
      }
      const totalDays = dayKeys.length;
      dayKeys.forEach((dateStr, i) => {
        const arr = groups.get(dateStr) ?? [];
        arr.push({ load, dayIndex: i + 1, totalDays });
        groups.set(dateStr, arr);
      });
    }

    const sortedKeys = [...groups.keys()].sort();
    return sortedKeys.map((dateStr) => ({
      title: fmtDateHeader(dateStr, todayKey),
      data:  (groups.get(dateStr) ?? []).sort((a, b) => a.load.start.localeCompare(b.load.start)),
    }));
  }, [loads, todayKey]);

  const listRef        = React.useRef<SectionList<DayEntry>>(null);
  const listContainer  = React.useRef<View>(null);
  const todayHeaderRef = React.useRef<View>(null);
  const scrollY        = React.useRef(0);

  function scrollToToday() {
    const header    = todayHeaderRef.current;
    const container = listContainer.current;
    if (!header || !container) return;

    // measure() gives each view's current position in window coordinates.
    // headerPageY = where today's header is on screen right now.
    // containerPageY = where the top of the list is on screen.
    // contentY = how far into the scroll content today's header sits.
    header.measure((_fx, _fy, _w, _h, _px, headerPageY) => {
      container.measure((_fx2, _fy2, _w2, _h2, _px2, containerPageY) => {
        const contentY = scrollY.current + (headerPageY - containerPageY);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (listRef.current?.getScrollResponder() as any)?.scrollTo({
          y: Math.max(0, contentY),
          animated: false,
        });
      });
    });
  }

  // Auto-scroll on first load
  const initialScrollDone = React.useRef(false);
  React.useEffect(() => {
    if (initialScrollDone.current || sections.length === 0) return;
    const id = setTimeout(() => {
      scrollToToday();
      initialScrollDone.current = true;
    }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }} edges={["top"]}>
      <View style={{ backgroundColor: "#1a73e8", paddingHorizontal: 22, paddingTop: 8, paddingBottom: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[txt(800), { flex: 1, fontSize: 22, color: "#ffffff", letterSpacing: -0.3 }]}>
            Schedule
          </Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            <TouchableOpacity
              onPress={() => setMode((m) => (m === "schedule" ? "day" : "schedule"))}
              activeOpacity={0.7}
              style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: "rgba(255,255,255,0.12)",
                borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
                alignItems: "center", justifyContent: "center",
              }}
            >
              {mode === "schedule"
                ? <CalendarDays size={15} color="#ffffff" strokeWidth={2.2} />
                : <List         size={15} color="#ffffff" strokeWidth={2.2} />}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (mode === "day") dayViewRef.current?.goToToday();
                else                scrollToToday();
              }}
              activeOpacity={0.7}
              style={{
                flexDirection: "row", alignItems: "center", gap: 6,
                paddingHorizontal: 12, paddingVertical: 8,
                borderRadius: 999,
                backgroundColor: "rgba(255,255,255,0.12)",
                borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
              }}
            >
              <CalendarCheck size={13} color="#ffffff" strokeWidth={2.4} />
              <Text style={[txt(800), { fontSize: 12, color: "#ffffff", letterSpacing: 0.3 }]}>
                Today
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
          <Calendar size={14} color="rgba(255,255,255,0.7)" strokeWidth={2.2} />
          <Text style={[txt(700), { fontSize: 12, color: "rgba(255,255,255,0.7)", letterSpacing: 0.3 }]}>
            {upcomingCount} load{upcomingCount === 1 ? "" : "s"} scheduled
          </Text>
        </View>
      </View>

      <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color="#1a73e8" />
        </View>
      ) : isError ? (
        // Wrap in a ScrollView so RefreshControl works — without this the
        // EmptyState is a static View and the user can't actually pull
        // down to retry, despite the subtitle saying they should.
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#1a73e8" />}
        >
          <EmptyState title="Could not load schedule" subtitle="Pull down to retry" />
        </ScrollView>
      ) : mode === "day" ? (
        <DayView ref={dayViewRef} loads={loads ?? []} />
      ) : sections.length === 0 ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#1a73e8" />}
        >
          <EmptyState title="No loads scheduled" subtitle="Check back when dispatch adds a load" Icon={Calendar} />
        </ScrollView>
      ) : (
        <View ref={listContainer} style={{ flex: 1 }}>
          <SectionList
            ref={listRef}
            sections={sections}
            keyExtractor={(item) => `${item.load.id}-${item.dayIndex}`}
            stickySectionHeadersEnabled
            initialNumToRender={500}
            windowSize={999}
            contentContainerStyle={{ paddingTop: 6, paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#1a73e8" />}
            onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}
            scrollEventThrottle={16}
            renderSectionHeader={({ section }) => {
              const isToday = section.title.startsWith("Today");
              return (
                <View
                  ref={isToday ? todayHeaderRef : undefined}
                  style={{
                    backgroundColor: "#f8f9fa",
                    paddingHorizontal: 16,
                    paddingTop: 14,
                    paddingBottom: 8,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {isToday ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#1a73e8" }} /> : null}
                  <Text style={[txt(800), { fontSize: 12, color: isToday ? "#1a73e8" : "#5f6368", letterSpacing: 0.6, textTransform: "uppercase" }]}>
                    {section.title}
                  </Text>
                </View>
              );
            }}
            renderItem={({ item }) => <ScheduleCard entry={item} />}
            onScrollToIndexFailed={() => {}}
          />
        </View>
      )}
      </View>
    </SafeAreaView>
  );
}
