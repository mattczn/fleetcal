import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
  Modal,
} from "react-native";
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, AlertTriangle, Moon, Sun } from "lucide-react-native";
import { SyncStatusPill } from "@/components/SyncStatusPill";
import { NotificationsBell } from "@/components/NotificationsBell";
import InspectionCard from "@/components/InspectionCard";
import InspectionFormScreen from "@/components/InspectionFormScreen";
import { fetchLoadsForDriver, fetchLoad } from "@/lib/api/loads";
import { LoadCard } from "@/components/LoadCard";
import { EmptyState } from "@/components/EmptyState";
import { useDriverSession } from "@/lib/useDriverSession";
import { useLoadsRealtime } from "@/lib/useLoadsRealtime";
import { usePushRegistration } from "@/lib/usePushRegistration";
import { useReportDevicePermissions } from "@/lib/useReportDevicePermissions";
import { railway } from "@/lib/railway";
import type { Load } from "@/lib/types";
import { Glass } from "@/components/Glass";
import { f, SP, RADIUS } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

const { width: SCREEN_W } = Dimensions.get("window");

/** "YYYY-MM-DDTHH:mm" naive local timestamp at `now + hours`. Loads
 *  carry start/end in this same naive shape so plain string compare
 *  works without parsing into Date objects. */
function naiveAtOffset(hours: number): string {
  const d = new Date(Date.now() + hours * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const TABS = ["Active", "Upcoming", "Recent"] as const;
type TabIdx = 0 | 1 | 2;

export default function LoadsScreen() {
  const insets = useSafeAreaInsets();
  const { C, SHADOW, ACCENT, isDark, toggle } = useTheme();
  const session = useDriverSession();
  const driver  = session.status === "matched" ? session.driver : null;
  useLoadsRealtime(driver?.driverId, driver?.orgId);
  // Registers the device for push silently. We intentionally don't surface
  // a "registration failed" banner — it's noise the driver can't action.
  usePushRegistration(driver?.driverId, driver?.orgId);
  // Observe-only — never prompts. Pings the API with the current
  // OS-level notification + location permissions so dispatch can
  // see them in the driver's profile.
  useReportDevicePermissions(driver?.driverId);

  const [activeTab, setActiveTab] = useState<TabIdx>(0);
  const pagerRef = useRef<ScrollView>(null);

  const queryClient = useQueryClient();
  const {
    data: loads,
    isLoading,
    refetch,
    isError,
  } = useQuery({
    queryKey: ["loads", driver?.driverId],
    queryFn:  () => fetchLoadsForDriver(driver!.driverId, driver!.orgId),
    enabled:  !!driver,
    // Reduce background refetches when hopping between tabs — the realtime
    // subscription invalidates on real changes, so 30s of staleness is fine.
    staleTime: 30_000,
  });
  // Only show the pull-to-refresh spinner for USER-initiated refreshes, not
  // background refetches (those were leaving a stale spinner spinning on
  // navigation, on top of the loaded content).
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try { await refetch(); } finally { setRefreshing(false); }
  };

  // Today's inspections drive the prompt card at the top of the
  // Active tab. Light query — driver-scoped + day-filtered server-side,
  // returns 0–3 rows in practice. Refetched after submit so the card
  // flips state immediately.
  const {
    data: inspectionData,
    isLoading: inspectionLoading,
    refetch: refetchInspections,
  } = useQuery({
    queryKey: ["inspections", "today", driver?.driverId],
    queryFn:  () => railway.todaysInspections(),
    enabled:  !!driver,
    staleTime: 60_000,
  });
  const todaysInspections = inspectionData?.inspections ?? [];
  const [inspectionFormOpen, setInspectionFormOpen] = useState(false);

  // Time-based bucketing — string-compare naive YYYY-MM-DDTHH:mm
  // timestamps against ±6h / ±24h offsets from now.
  //   Active   = overlapping the ±6h window (in transit, just delivered,
  //              or picking up soon)
  //   Recent   = end fell between 6 h and 24 h ago
  //   Upcoming = start lands between 6 h and 24 h ahead
  // Anything older than 24 h ago or further than 24 h ahead drops off
  // the home screen entirely (still surfaced via the schedule view).
  const { activeLoads, upcomingLoads, recentLoads, within24h } = useMemo(() => {
    const now    = naiveAtOffset(0);
    const m6h    = naiveAtOffset(-6);
    const p6h    = naiveAtOffset(6);
    const m24h   = naiveAtOffset(-24);
    const p24h   = naiveAtOffset(24);
    const all = loads ?? [];
    const active   = all.filter((l) => l.start <= p6h  && (l.end ?? l.start) >= m6h);
    const recent   = all.filter((l) => (l.end ?? l.start) <  m6h && (l.end ?? l.start) >= m24h);
    const upcoming = all.filter((l) => l.start > p6h && l.start <= p24h);
    const within24 = all.filter((l) => l.start <= p24h && (l.end ?? l.start) >= m24h);
    void now; // exposed for clarity even though unused
    return {
      activeLoads:   active,
      upcomingLoads: upcoming,
      recentLoads:   recent,
      within24h:     within24,
    };
  }, [loads]);

  // Prefetch the full load detail (with relay partner stops, etc.) for
  // every load in the ±24h window so tapping into one is instant and
  // works offline if the device drops connectivity later.
  useEffect(() => {
    if (!driver) return;
    for (const load of within24h) {
      queryClient.prefetchQuery({
        queryKey: ["load", load.id],
        queryFn:  () => fetchLoad(load.id, driver.driverId, driver.orgId),
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [within24h, driver, queryClient]);

  const tabData: Load[][] = [activeLoads, upcomingLoads, recentLoads];

  function selectTab(idx: TabIdx) {
    setActiveTab(idx);
    pagerRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
  }

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  const emptyLabels = [
    { title: "Nothing active",  subtitle: "Loads in transit, delivered in the last 6 h, or picking up in the next 6 h show here." },
    { title: "Nothing upcoming", subtitle: "Loads picking up 6–24 h from now show here." },
    { title: "Nothing recent",   subtitle: "Loads delivered 6–24 h ago show here." },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style={isDark ? "light" : "dark"} />

      {/* Glass header */}
      <Glass
        deep
        radii={{ borderBottomLeftRadius: RADIUS.headerList, borderBottomRightRadius: RADIUS.headerList }}
        style={{ paddingTop: insets.top + 8, paddingHorizontal: SP.screenPx, paddingBottom: 12, zIndex: 10 }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[f(600), { fontSize: 13, color: C.t3, letterSpacing: 0.1 }]}>{greeting},</Text>
            <Text style={[f(800), { fontSize: 27, color: C.t1, marginTop: 1, letterSpacing: -0.6 }]} numberOfLines={1}>
              {driver?.name ?? "Driver"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <SyncStatusPill />
            <TouchableOpacity
              onPress={toggle}
              activeOpacity={0.8}
              accessibilityLabel="Toggle dark mode"
              style={{ width: 36, height: 36, borderRadius: RADIUS.iconBtn, alignItems: "center", justifyContent: "center" }}
            >
              {isDark ? <Sun size={19} color={C.t2} strokeWidth={2.2} /> : <Moon size={19} color={C.t2} strokeWidth={2.2} />}
            </TouchableOpacity>
            <NotificationsBell tint="dark" />
          </View>
        </View>

        {/* Segmented tabs */}
        <View style={{ flexDirection: "row", gap: 3, marginTop: 16, padding: 4, borderRadius: 14, backgroundColor: C.surfaceSunk }}>
          {TABS.map((tab, i) => {
            const count = tabData[i]?.length ?? 0;
            const isActive = activeTab === i;
            return (
              <TouchableOpacity
                key={tab}
                onPress={() => selectTab(i as TabIdx)}
                activeOpacity={0.8}
                style={[
                  { flex: 1, height: 36, borderRadius: 11, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
                  isActive && { backgroundColor: C.surface, ...SHADOW.card },
                ]}
              >
                <Text style={[f(700), { fontSize: 13.5, color: isActive ? C.t1 : C.t3, letterSpacing: -0.1 }]}>{tab}</Text>
                {count > 0 ? (
                  <View style={{
                    minWidth: 19, height: 19, paddingHorizontal: 5, borderRadius: 999,
                    alignItems: "center", justifyContent: "center",
                    backgroundColor: isActive ? ACCENT : C.border,
                  }}>
                    <Text style={[f(800), { fontSize: 10.5, color: isActive ? "#ffffff" : C.t3 }]}>{count}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </Glass>

      {isLoading ? (
        <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : isError ? (
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          <EmptyState title="Could not load schedule" subtitle="Pull down to retry" Icon={AlertTriangle} />
        </View>
      ) : (
        <ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onMomentumScrollEnd={(e) => {
            const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W) as TabIdx;
            setActiveTab(idx);
          }}
          style={{ flex: 1 }}
        >
          {tabData.map((data, tabIdx) => (
            <FlatList
              key={tabIdx}
              data={data}
              keyExtractor={(item) => item.id}
              style={{ width: SCREEN_W, backgroundColor: C.bg }}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 0, paddingTop: SP.cgap, paddingBottom: 24, flexGrow: 1 }}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />
              }
              // Inspection card pinned to the top of the Active tab only.
              ListHeaderComponent={tabIdx === 0 ? (
                <InspectionCard
                  loading={inspectionLoading}
                  inspections={todaysInspections}
                  onStart={() => setInspectionFormOpen(true)}
                />
              ) : null}
              renderItem={({ item }) => (
                <View style={{ paddingHorizontal: SP.screenPx }}>
                  <LoadCard load={item} />
                </View>
              )}
              ListEmptyComponent={
                <View style={{ paddingHorizontal: SP.screenPx, paddingTop: 16, flexGrow: 1 }}>
                  <EmptyState
                    title={emptyLabels[tabIdx].title}
                    subtitle={emptyLabels[tabIdx].subtitle}
                    Icon={Inbox}
                  />
                </View>
              }
            />
          ))}
        </ScrollView>
      )}

      {/* Inspection form — full-screen modal. <Modal> renders into its own
          native root OUTSIDE expo-router's SafeAreaProvider, so we re-inject
          one here for correct insets. */}
      <Modal
        visible={inspectionFormOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setInspectionFormOpen(false)}
      >
        <SafeAreaProvider>
          <SafeAreaView style={{ flex: 1, backgroundColor: "white" }} edges={["top"]}>
            <InspectionFormScreen
              driverName={driver?.name ?? "Driver"}
              onClose={() => setInspectionFormOpen(false)}
              onSubmitted={() => {
                setInspectionFormOpen(false);
                void refetchInspections();
              }}
            />
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </View>
  );
}
