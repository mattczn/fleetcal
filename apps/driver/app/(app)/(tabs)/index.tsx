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
import { SafeAreaView, SafeAreaProvider } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, AlertTriangle } from "lucide-react-native";
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

const { width: SCREEN_W } = Dimensions.get("window");

/** "YYYY-MM-DDTHH:mm" naive local timestamp at `now + hours`. Loads
 *  carry start/end in this same naive shape so plain string compare
 *  works without parsing into Date objects. */
function naiveAtOffset(hours: number): string {
  const d = new Date(Date.now() + hours * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const TABS = ["Active", "Upcoming", "Recent"] as const;
type TabIdx = 0 | 1 | 2;

export default function LoadsScreen() {
  const session = useDriverSession();
  const driver  = session.status === "matched" ? session.driver : null;
  useLoadsRealtime(driver?.driverId, driver?.orgId);
  const pushStatus = usePushRegistration(driver?.driverId, driver?.orgId);
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
    isRefetching,
    refetch,
    isError,
  } = useQuery({
    queryKey: ["loads", driver?.driverId],
    queryFn:  () => fetchLoadsForDriver(driver!.driverId, driver!.orgId),
    enabled:  !!driver,
  });

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
  // works offline if the device drops connectivity later. The list query
  // already returns most fields, but the detail endpoint also surfaces
  // relay partner info that the list omits.
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
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }} edges={["top"]}>
      {/* Header */}
      <View style={{ backgroundColor: "#1a73e8", paddingHorizontal: 22, paddingTop: 8, paddingBottom: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <Text style={[txt(500), { fontSize: 13, color: "rgba(255,255,255,0.6)" }]}>
              {greeting},
            </Text>
            <Text style={[txt(800), { fontSize: 26, color: "#ffffff", marginTop: 2, letterSpacing: -0.3 }]}>
              {driver?.name ?? "Driver"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
            <SyncStatusPill />
            <NotificationsBell tint="light" />
          </View>
        </View>

        {/* Tab bar */}
        <View style={{ flexDirection: "row", marginTop: 18 }}>
          {TABS.map((tab, i) => {
            const count = tabData[i]?.length ?? 0;
            const isActive = activeTab === i;
            return (
              <TouchableOpacity
                key={tab}
                onPress={() => selectTab(i as TabIdx)}
                activeOpacity={0.7}
                style={{ flex: 1, alignItems: "center", paddingBottom: 12 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <Text style={[
                    txt(isActive ? 800 : 600),
                    { fontSize: 13, color: isActive ? "#ffffff" : "rgba(255,255,255,0.55)" },
                  ]}>
                    {tab}
                  </Text>
                  {count > 0 ? (
                    <View style={{
                      minWidth: 18, height: 18, borderRadius: 9,
                      backgroundColor: isActive ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)",
                      paddingHorizontal: 5,
                      alignItems: "center", justifyContent: "center",
                    }}>
                      <Text style={[txt(800), { fontSize: 10, color: isActive ? "#ffffff" : "rgba(255,255,255,0.5)" }]}>
                        {count}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {/* Active indicator */}
                <View style={{
                  height: 3,
                  width: "60%",
                  borderRadius: 2,
                  backgroundColor: isActive ? "#ffffff" : "transparent",
                }} />
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {(pushStatus === "denied" || pushStatus === "failed") && (
        // Visible banner so the driver knows push isn't working — silent
        // failure was leaving drivers with no pings + no way to tell.
        // 'denied' usually means iOS notification permission was declined
        // (Settings → Notifications → Curzon). 'failed' means
        // permission's fine but token registration with the server
        // didn't go through after retries.
        <View style={{ backgroundColor: "#fef3c7", paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#fde68a" }}>
          <Text style={[txt(700), { fontSize: 12, color: "#92400e" }]}>
            {pushStatus === "denied" ? "Push notifications are off" : "Push registration failed"}
          </Text>
          <Text style={[txt(500), { fontSize: 11, color: "#92400e", marginTop: 2 }]}>
            {pushStatus === "denied"
              ? "Enable notifications in Settings → Notifications → Curzon so dispatch can reach you."
              : "We couldn't register this device for push. Pull down to retry, or restart the app."}
          </Text>
        </View>
      )}

      {isLoading ? (
        <View style={{ flex: 1, backgroundColor: "#f8f9fa", alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color="#1a73e8" />
        </View>
      ) : isError ? (
        <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
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
              style={{ width: SCREEN_W, backgroundColor: "#f8f9fa" }}
              contentContainerStyle={{ paddingHorizontal: 0, paddingTop: 4, paddingBottom: 40, flexGrow: 1 }}
              refreshControl={
                <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#1a73e8" />
              }
              // Inspection card is pinned to the top of the Active tab
              // only — Upcoming/Recent don't need it. Wrapping the card
              // (which already has its own marginHorizontal/marginTop)
              // in a plain View lets the FlatList container drop its
              // padding so the card sits flush.
              ListHeaderComponent={tabIdx === 0 ? (
                <InspectionCard
                  loading={inspectionLoading}
                  inspections={todaysInspections}
                  onStart={() => setInspectionFormOpen(true)}
                />
              ) : null}
              renderItem={({ item }) => (
                <View style={{ paddingHorizontal: 16 }}>
                  <LoadCard load={item} />
                </View>
              )}
              ListEmptyComponent={
                <View style={{ paddingHorizontal: 16, paddingTop: 16, flexGrow: 1 }}>
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

      {/* Inspection form — full-screen modal. On submit, refetch the
          today's-inspections query so the card flips to its green
          state and lists the new entry.

          IMPORTANT: <Modal> renders into its own native root view that
          is OUTSIDE expo-router's SafeAreaProvider. Without an explicit
          provider here, the SafeAreaView falls back to zero insets and
          the back-arrow lands underneath the dynamic island. Wrapping
          the modal contents with our own SafeAreaProvider re-injects
          the insets so edges={["top"]} actually pushes the header
          below the island. */}
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
    </SafeAreaView>
  );
}
