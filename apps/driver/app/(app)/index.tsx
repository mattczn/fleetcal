import React, { useRef, useState } from "react";
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
import { useQuery } from "@tanstack/react-query";
import { Inbox, AlertTriangle } from "lucide-react-native";
import { SyncStatusPill } from "@/components/SyncStatusPill";
import { fetchLoadsForDriver } from "@/lib/api/loads";
import { LoadCard } from "@/components/LoadCard";
import { EmptyState } from "@/components/EmptyState";
import { useDriverSession } from "@/lib/useDriverSession";
import { useLoadsRealtime } from "@/lib/useLoadsRealtime";
import { usePushRegistration } from "@/lib/usePushRegistration";
import type { Load } from "@/lib/types";

const { width: SCREEN_W } = Dimensions.get("window");

const ACTIVE_STATUSES   = new Set(["en_route", "picked_up"]);
const UPCOMING_STATUSES = new Set(["scheduled", "dispatched"]);

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

  const activeLoads:   Load[] = loads?.filter((l) => ACTIVE_STATUSES.has(l.status))   ?? [];
  const upcomingLoads: Load[] = loads?.filter((l) => UPCOMING_STATUSES.has(l.status)) ?? [];
  const otherLoads:    Load[] = loads?.filter(
    (l) => !ACTIVE_STATUSES.has(l.status) && !UPCOMING_STATUSES.has(l.status),
  ) ?? [];

  const tabData: Load[][] = [activeLoads, upcomingLoads, otherLoads];

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
    { title: "No active loads", subtitle: "Loads in progress will appear here" },
    { title: "No upcoming loads", subtitle: "Check back when dispatch adds a load" },
    { title: "No recent loads", subtitle: "Past loads will appear here" },
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
          <View style={{ marginTop: 6 }}>
            <SyncStatusPill />
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
