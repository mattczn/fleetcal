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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, AlertTriangle } from "lucide-react-native";
import { SyncStatusPill } from "@/components/SyncStatusPill";
import { NotificationsBell } from "@/components/NotificationsBell";
import { fetchLoadsForDriver, fetchLoad } from "@/lib/api/loads";
import { LoadCard } from "@/components/LoadCard";
import { EmptyState } from "@/components/EmptyState";
import { useDriverSession } from "@/lib/useDriverSession";
import { useLoadsRealtime } from "@/lib/useLoadsRealtime";
import { usePushRegistration } from "@/lib/usePushRegistration";
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
  usePushRegistration(driver?.driverId, driver?.orgId);

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
              contentContainerStyle={{ padding: 16, paddingBottom: 40, flexGrow: 1 }}
              refreshControl={
                <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#1a73e8" />
              }
              renderItem={({ item }) => <LoadCard load={item} />}
              ListEmptyComponent={
                <EmptyState
                  title={emptyLabels[tabIdx].title}
                  subtitle={emptyLabels[tabIdx].subtitle}
                  Icon={Inbox}
                />
              }
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
