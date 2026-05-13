import React, { useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useOrganization, useUser } from "@clerk/clerk-expo";
import {
  Plus, Search, X, CalendarDays, Map as MapIcon, ChevronRight, User as UserIcon, Truck, Wrench,
} from "lucide-react-native";
import { fetchAssets, searchLoads } from "@/lib/api";
import { useDebounce } from "@/lib/useDebounce";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { LoadResultCard } from "@/components/LoadResultCard";
import { TrucksMap } from "@/components/TrucksMap";
import { AssetPickerSheet } from "@/components/AssetPickerSheet";
import { txt } from "@/lib/font";

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { organization } = useOrganization();
  const { user } = useUser();
  const orgId = organization?.id;

  const [searchQuery, setSearchQuery] = useState("");
  const [calendarPickerOpen, setCalendarPickerOpen] = useState(false);
  const [trucksPickerOpen, setTrucksPickerOpen] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const online = useOnlineStatus();

  const { data: assets = [] } = useQuery({
    queryKey: ["assets", orgId],
    queryFn:  () => fetchAssets(orgId!),
    enabled:  !!orgId,
    staleTime: 5 * 60 * 1000,
  });
  const visibleAssets = assets.filter((a) => !a.hidden);
  const debouncedQuery = useDebounce(searchQuery.trim(), 250);
  const isSearching = debouncedQuery.length > 0;

  const { data: searchResults = [], isFetching: isSearchFetching } = useQuery({
    queryKey: ["search-loads", orgId, debouncedQuery],
    queryFn:  () => searchLoads(orgId!, debouncedQuery),
    enabled:  !!orgId && isSearching,
    staleTime: 30 * 1000,
  });

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();
  const firstName = user?.firstName || (user?.fullName ?? "").split(" ")[0] || "";

  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {/* Header */}
      <View style={{ backgroundColor: "#1a73e8", paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 18 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={[txt(500), { fontSize: 13, color: "rgba(255,255,255,0.7)" }]}>
              {greeting}{firstName ? `, ${firstName}` : ""}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 }}>
              <Text style={[txt(800), { fontSize: 22, color: "#ffffff", letterSpacing: -0.3 }]}>
                DispatchGo
              </Text>
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 5,
                paddingHorizontal: 8, paddingVertical: 3,
                borderRadius: 999,
                backgroundColor: "rgba(255,255,255,0.14)",
              }}>
                <View style={{
                  width: 7, height: 7, borderRadius: 999,
                  backgroundColor: online ? "#34d399" : "#fca5a5",
                }} />
                <Text style={[txt(800), { fontSize: 10, color: "#ffffff", letterSpacing: 0.4 }]}>
                  {online ? "ONLINE" : "OFFLINE"}
                </Text>
              </View>
            </View>
          </View>
          <TouchableOpacity
            onPress={() => router.push("/profile")}
            hitSlop={10}
            style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }}
          >
            <UserIcon size={17} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Persistent search pill — flat, blends into the body */}
      <View style={{
        paddingHorizontal: 14, paddingTop: 14, paddingBottom: 6,
        backgroundColor: "#f8f9fa",
      }}>
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 10,
          paddingHorizontal: 16, paddingVertical: 12,
          backgroundColor: "#eef0f2",
          borderRadius: 999,
        }}>
          <Search size={18} color="#1a73e8" strokeWidth={2.4} />
          <TextInput
            ref={searchInputRef}
            placeholder="Find a Load"
            placeholderTextColor="#9aa0a6"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={[txt(700), { flex: 1, fontSize: 15, color: "#202124", padding: 0 }]}
          />
          {searchQuery ? (
            <TouchableOpacity
              onPress={() => setSearchQuery("")}
              hitSlop={8}
              style={{
                width: 26, height: 26, borderRadius: 13,
                backgroundColor: "#f1f3f4",
                alignItems: "center", justifyContent: "center",
              }}
            >
              <X size={14} color="#5f6368" strokeWidth={2.6} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {isSearching ? (
        // Search results take over the body
        <ScrollView
          style={{ flex: 1, backgroundColor: "#f8f9fa" }}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 + insets.bottom }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", textTransform: "uppercase", marginBottom: 10 }]}>
            {isSearchFetching ? "Searching…" : `${searchResults.length} ${searchResults.length === 1 ? "result" : "results"}`}
          </Text>
          {searchResults.length === 0 && !isSearchFetching ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <Text style={[txt(700), { fontSize: 14, color: "#3c4043" }]}>No loads match</Text>
              <Text style={[txt(500), { fontSize: 12, color: "#9aa0a6", marginTop: 4 }]}>
                Try a different load number, broker, or driver.
              </Text>
            </View>
          ) : (
            searchResults.map((load) => <LoadResultCard key={load.id} load={load} />)
          )}
        </ScrollView>
      ) : (
        <ScrollView
          style={{ flex: 1, backgroundColor: "#f8f9fa" }}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 + insets.bottom }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Primary CTA: + Load */}
          <TouchableOpacity
            onPress={() => router.push("/new-load")}
            activeOpacity={0.88}
            style={{
              backgroundColor: "#1a73e8",
              borderRadius: 16,
              padding: 18,
              flexDirection: "row", alignItems: "center", gap: 14,
              shadowColor: "#1a73e8", shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
              marginBottom: 16,
            }}
          >
            <View style={{
              width: 44, height: 44, borderRadius: 14,
              backgroundColor: "rgba(255,255,255,0.2)",
              alignItems: "center", justifyContent: "center",
            }}>
              <Plus size={22} color="#ffffff" strokeWidth={2.6} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 15, color: "#ffffff", letterSpacing: 0.2 }]}>
                New Load
              </Text>
              <Text style={[txt(500), { fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 3 }]}>
                Upload a rate con and let AI fill it in.
              </Text>
            </View>
            <ChevronRight size={18} color="#ffffff" strokeWidth={2.4} />
          </TouchableOpacity>

          {/* Quick links */}
          <View style={{ flexDirection: "row", gap: 10, marginBottom: 18 }}>
            <QuickLink
              label="Calendar"
              hint="Pick an asset"
              Icon={CalendarDays}
              onPress={() => setCalendarPickerOpen(true)}
            />
            <QuickLink
              label="Trucks"
              hint="Zoom to truck"
              Icon={Truck}
              onPress={() => setTrucksPickerOpen(true)}
              tint="#15803d"
              tintBg="#dcfce7"
            />
            <QuickLink
              label="Maintenance"
              hint="Reports & work"
              Icon={Wrench}
              onPress={() => router.push("/maintenance")}
              tint="#9a3412"
              tintBg="#fed7aa"
            />
          </View>

          {/* Trucks map */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
            <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", textTransform: "uppercase", flex: 1 }]}>
              Live Trucks
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <MapIcon size={11} color="#9aa0a6" strokeWidth={2.2} />
              <Text style={[txt(700), { fontSize: 11, color: "#9aa0a6" }]}>
                Motive · 5m cache
              </Text>
            </View>
          </View>
          <TrucksMap height={260} />
        </ScrollView>
      )}

      <AssetPickerSheet
        visible={calendarPickerOpen}
        title="Open calendar for…"
        hint="Jump straight to that asset's day."
        assets={visibleAssets}
        onClose={() => setCalendarPickerOpen(false)}
        onSelect={(a) => {
          setCalendarPickerOpen(false);
          router.push({ pathname: "/calendar", params: { assetId: String(a.id) } });
        }}
      />

      <AssetPickerSheet
        visible={trucksPickerOpen}
        title="Zoom to truck…"
        hint="Open the live map focused on this truck."
        assets={visibleAssets}
        onClose={() => setTrucksPickerOpen(false)}
        onSelect={(a) => {
          setTrucksPickerOpen(false);
          router.push({ pathname: "/map", params: { assetId: String(a.id) } });
        }}
      />

    </View>
  );
}

function QuickLink({
  label, hint, Icon, onPress, tint = "#1a73e8", tintBg = "#e8f0fe",
}: {
  label: string; hint: string;
  Icon: typeof Truck;
  onPress: () => void;
  tint?: string; tintBg?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        flex: 1,
        backgroundColor: "#ffffff",
        borderRadius: 14,
        padding: 14,
        borderWidth: 1, borderColor: "#e8eaed",
      }}
    >
      <View style={{
        width: 36, height: 36, borderRadius: 10,
        backgroundColor: tintBg,
        alignItems: "center", justifyContent: "center",
        marginBottom: 8,
      }}>
        <Icon size={18} color={tint} strokeWidth={2.2} />
      </View>
      <Text style={[txt(800), { fontSize: 14, color: "#202124" }]}>{label}</Text>
      <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>{hint}</Text>
    </TouchableOpacity>
  );
}
