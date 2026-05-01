import React, { useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Dimensions, ActivityIndicator,
  RefreshControl, TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useUser, useAuth, useOrganization } from "@clerk/clerk-expo";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, CalendarCheck, Truck, Menu, Calendar as CalendarIcon, Search, X, User as UserIcon, Plus, ArrowLeft } from "lucide-react-native";
import { fetchAssets, fetchLoadsForDay, searchLoads } from "@/lib/api";
import { txt } from "@/lib/font";
import { lighten, readableOn } from "@/lib/color";
import { useAssetPrefs } from "@/lib/useAssetPrefs";
import { useDebounce } from "@/lib/useDebounce";
import { AssetSidePanel } from "@/components/AssetSidePanel";
import { DatePickerModal } from "@/components/DatePickerModal";
import { LoadResultCard } from "@/components/LoadResultCard";
import type { Asset, Load } from "@/lib/types";

const HOUR_HEIGHT      = 60;
const HOUR_LABEL_WIDTH = 56;

function pad(n: number) { return String(n).padStart(2, "0"); }
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function shiftKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtHeader(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const yest = new Date(today);     yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const date = d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    year: today.getFullYear() !== d.getFullYear() ? "numeric" : undefined,
  });
  if (same(d, today))    return `Today · ${date}`;
  if (same(d, tomorrow)) return `Tomorrow · ${date}`;
  if (same(d, yest))     return `Yesterday · ${date}`;
  return date;
}

function fmtTime(iso: string): string {
  if (!iso) return "";
  const t = iso.slice(11, 16);
  if (!t) return "";
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return m === 0 ? `${hh} ${ampm}` : `${hh}:${pad(m)} ${ampm}`;
}

interface PositionedLoad {
  load:        Load;
  top:         number;  // px
  height:      number;
  spansBefore: boolean; // event started yesterday or earlier
  spansAfter:  boolean; // event ends tomorrow or later
}

/**
 * Map a load's start/end (naive YYYY-MM-DDTHH:mm) onto the 24h timeline of
 * `dateKey`, clipping if the load extends outside the day.
 */
function positionFor(load: Load, dateKey: string): PositionedLoad | null {
  const startKey = load.start.slice(0, 10);
  const endKey   = load.end.slice(0, 10);
  if (dateKey < startKey || dateKey > endKey) return null;

  const minutesOfDay = (iso: string): number => {
    const t = iso.slice(11, 16);
    if (!t) return 0;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };

  const startMin = dateKey === startKey ? minutesOfDay(load.start) : 0;
  const endMin   = dateKey === endKey   ? minutesOfDay(load.end)   : 24 * 60;
  const top      = (startMin / 60) * HOUR_HEIGHT;
  const height   = Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 26);

  return {
    load, top, height,
    spansBefore: dateKey !== startKey,
    spansAfter:  dateKey !== endKey,
  };
}

function LoadBlock({ p, assetColor }: { p: PositionedLoad; assetColor?: string }) {
  const router = useRouter();
  const stripe   = assetColor ?? "#1a73e8";
  const bg       = lighten(assetColor ?? "#1a73e8", 0.82);
  const titleFg  = readableOn(assetColor);
  const startLabel = p.spansBefore ? "Continues" : fmtTime(p.load.start);
  const endLabel   = p.spansAfter  ? "Continues" : fmtTime(p.load.end);
  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: p.load.id } })}
      activeOpacity={0.85}
      style={{
        position: "absolute", top: p.top, height: p.height,
        left: HOUR_LABEL_WIDTH + 6, right: 8,
        backgroundColor: bg,
        borderLeftWidth: 4, borderLeftColor: stripe,
        borderRadius: 8, padding: 6, overflow: "hidden",
      }}
    >
      <Text style={[txt(800), { fontSize: 11, color: stripe, letterSpacing: 0.2 }]} numberOfLines={1}>
        {startLabel}{startLabel !== endLabel ? ` – ${endLabel}` : ""}
      </Text>
      <Text style={[txt(800), { fontSize: 13, color: titleFg, marginTop: 1 }]} numberOfLines={2}>
        {p.load.title}
      </Text>
      {p.height >= 64 && p.load.driverName ? (
        <Text style={[txt(600), { fontSize: 11, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
          {p.load.driverName}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function HourGrid() {
  const hours = useMemo(() => Array.from({ length: 24 }, (_, h) => h), []);
  return (
    <View style={{ height: 24 * HOUR_HEIGHT }}>
      {hours.map((h) => {
        const ampm = h >= 12 ? "PM" : "AM";
        const hh = h % 12 || 12;
        return (
          <View key={h} style={{
            position: "absolute", top: h * HOUR_HEIGHT, left: 0, right: 0, height: HOUR_HEIGHT,
            borderTopWidth: 1, borderTopColor: "#f1f3f4",
            flexDirection: "row",
          }}>
            <View style={{ width: HOUR_LABEL_WIDTH, paddingLeft: 8, paddingTop: 2 }}>
              <Text style={[txt(700), { fontSize: 11, color: "#9aa0a6" }]}>
                {hh}{h === 0 ? "" : ` ${ampm}`}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function NowLine({ dateKey }: { dateKey: string }) {
  const [now, setNow] = useState(new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (todayKey() !== dateKey) return null;
  const top = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;
  return (
    <View style={{ position: "absolute", top, left: HOUR_LABEL_WIDTH, right: 0, flexDirection: "row", alignItems: "center" }} pointerEvents="none">
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#ea4335", marginLeft: -4 }} />
      <View style={{ flex: 1, height: 2, backgroundColor: "#ea4335" }} />
    </View>
  );
}

interface AssetPageProps {
  asset:    Asset;
  dateKey:  string;
  loads:    Load[];
  width:    number;
  /** Mutable Y offset shared across all pages — updated on scroll, applied on swipe-in. */
  sharedScrollY: React.MutableRefObject<number>;
  /** Register this page's ScrollView ref so the parent can scroll it on swipe-in. */
  registerRef:   (id: number, ref: ScrollView | null) => void;
}

function AssetPage({ asset, dateKey, loads, width, sharedScrollY, registerRef }: AssetPageProps) {
  const positioned = useMemo(
    () => loads
      .filter((l) => l.assetId === asset.id)
      .map((l) => positionFor(l, dateKey))
      .filter((p): p is PositionedLoad => p !== null),
    [loads, asset.id, dateKey],
  );

  return (
    <View style={{ width, flex: 1 }}>
      <ScrollView
        ref={(r) => registerRef(asset.id, r)}
        style={{ flex: 1, backgroundColor: "#ffffff" }}
        contentContainerStyle={{ paddingBottom: 40 }}
        scrollEventThrottle={16}
        onScroll={(e) => { sharedScrollY.current = e.nativeEvent.contentOffset.y; }}
        contentOffset={{ x: 0, y: sharedScrollY.current }}
      >
        <View style={{ position: "relative" }}>
          <HourGrid />
          {positioned.map((p) => <LoadBlock key={p.load.id} p={p} assetColor={asset.color} />)}
          <NowLine dateKey={dateKey} />
        </View>
      </ScrollView>
    </View>
  );
}

export default function CalendarScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ assetId?: string }>();
  const requestedAssetId = params.assetId ? parseInt(params.assetId, 10) : null;
  const { signOut } = useAuth();
  const { user } = useUser();
  const { organization } = useOrganization();
  const orgId = organization?.id;

  const SCREEN_W = Dimensions.get("window").width;
  const [dateKey, setDateKey] = useState(todayKey());
  const [assetIdx, setAssetIdx] = useState(0);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<TextInput>(null);
  const pagerRef = useRef<ScrollView>(null);

  // Shared vertical scroll position across all asset pages — preserves the
  // 6am-12pm view (or wherever the dispatcher is looking) when swiping assets.
  const sharedScrollY = useRef(0);
  const pageScrollRefs = useRef<Map<number, ScrollView | null>>(new Map());
  const registerPageRef = React.useCallback((id: number, ref: ScrollView | null) => {
    pageScrollRefs.current.set(id, ref);
  }, []);

  const { data: assets = [], isLoading: assetsLoading, refetch: refetchAssets } = useQuery({
    queryKey: ["assets", orgId],
    queryFn:  () => fetchAssets(orgId!),
    enabled:  !!orgId,
    staleTime: 60 * 1000,
  });

  const { visibleAssets, orderedIds, prefs, setHidden, setAllHidden, move } = useAssetPrefs(orgId, assets);
  const [panelOpen, setPanelOpen] = useState(false);

  // Jump to a requested asset (?assetId=X). If the user has personally hidden
  // the asset in their side-panel prefs, transparently unhide it first so the
  // calendar can show it. (DB-level `assets.hidden` is still respected.)
  const jumpedRef = useRef(false);
  React.useEffect(() => {
    if (jumpedRef.current || !requestedAssetId || assets.length === 0) return;
    const target = assets.find((a) => a.id === requestedAssetId);
    if (!target || target.hidden) return;

    if (prefs.hidden.includes(target.id)) {
      setHidden(target.id, false);
      return; // re-runs after prefs update, visibleAssets will include the asset
    }

    const idx = visibleAssets.findIndex((a) => a.id === target.id);
    if (idx < 0) return;
    jumpedRef.current = true;
    setAssetIdx(idx);
    setTimeout(() => pagerRef.current?.scrollTo({ x: idx * SCREEN_W, animated: false }), 50);
  }, [requestedAssetId, assets, prefs.hidden, visibleAssets, SCREEN_W, setHidden]);

  const { data: loads = [], isLoading: loadsLoading, isRefetching, refetch } = useQuery({
    queryKey: ["loads", orgId, dateKey],
    queryFn:  () => fetchLoadsForDay(orgId!, dateKey),
    enabled:  !!orgId,
  });

  // Server-side search across ALL dates. Debounced so we don't spam Supabase
  // on every keystroke. Empty query = no search.
  const debouncedQuery = useDebounce(searchQuery.trim(), 250);
  const isSearching = debouncedQuery.length > 0;

  const { data: searchResults = [], isFetching: isSearchFetching } = useQuery({
    queryKey: ["search-loads", orgId, debouncedQuery],
    queryFn:  () => searchLoads(orgId!, debouncedQuery),
    enabled:  !!orgId && isSearching,
    staleTime: 30 * 1000,
  });

  // Reset asset index when assets change to avoid out-of-bounds
  React.useEffect(() => {
    if (assetIdx >= visibleAssets.length) setAssetIdx(0);
  }, [visibleAssets.length, assetIdx]);

  function selectAsset(idx: number) {
    setAssetIdx(idx);
    pagerRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
  }

  function shiftDate(days: number) {
    setDateKey((k) => shiftKey(k, days));
  }

  const insets = useSafeAreaInsets();

  if (!orgId) {
    return (
      <View style={{ flex: 1, backgroundColor: "#f8f9fa", alignItems: "center", justifyContent: "center", padding: 24, paddingTop: insets.top + 24 }}>
        <Text style={[txt(800), { fontSize: 18, color: "#202124", textAlign: "center" }]}>
          No organization selected
        </Text>
        <Text style={[txt(500), { fontSize: 13, color: "#5f6368", marginTop: 8, textAlign: "center" }]}>
          {user?.primaryEmailAddress?.emailAddress
            ? `Signed in as ${user.primaryEmailAddress.emailAddress}, but you don't have access to a Curzon org.`
            : "Set an active organization in your Clerk dashboard to continue."}
        </Text>
        <TouchableOpacity onPress={() => signOut()} style={{ marginTop: 22, paddingHorizontal: 18, paddingVertical: 10, backgroundColor: "#1a73e8", borderRadius: 999 }}>
          <Text style={[txt(700), { color: "#ffffff", fontSize: 13 }]}>Sign out</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const activeAsset = visibleAssets[assetIdx];

  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
      {/* Header */}
      <View style={{ backgroundColor: "#1a73e8", paddingHorizontal: 16, paddingTop: insets.top + 6, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {requestedAssetId ? (
            <TouchableOpacity onPress={() => router.back()} hitSlop={10}
              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" }}>
              <ArrowLeft size={16} color="#ffffff" strokeWidth={2.2} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setPanelOpen(true)} hitSlop={10}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" }}>
            <Menu size={16} color="#ffffff" strokeWidth={2.2} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setDatePickerOpen(true)}
            activeOpacity={0.7}
            style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Text style={[txt(800), { fontSize: 20, color: "#ffffff", letterSpacing: -0.3, flex: 1 }]} numberOfLines={1}>
              {fmtHeader(dateKey)}
            </Text>
            <CalendarIcon size={14} color="rgba(255,255,255,0.7)" strokeWidth={2.2} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/new-load")}
            hitSlop={10}
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}
          >
            <Plus size={18} color="#ffffff" strokeWidth={2.6} />
          </TouchableOpacity>
        </View>

        {/* Date stepper */}
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, gap: 8 }}>
          <TouchableOpacity onPress={() => shiftDate(-1)} hitSlop={8}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft size={16} color="#ffffff" strokeWidth={2.4} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDateKey(todayKey())}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: 999 }}>
            <CalendarCheck size={13} color="#ffffff" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 12, color: "#ffffff", letterSpacing: 0.3 }]}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => shiftDate(1)} hitSlop={8}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }}>
            <ChevronRight size={16} color="#ffffff" strokeWidth={2.4} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Truck size={12} color="rgba(255,255,255,0.7)" strokeWidth={2.2} />
            <Text style={[txt(700), { fontSize: 12, color: "rgba(255,255,255,0.7)" }]}>
              {activeAsset ? `${assetIdx + 1} / ${visibleAssets.length}` : ""}
            </Text>
          </View>
        </View>
      </View>

      {/* Asset name bar — only shown when not actively searching */}
      {!isSearching ? (
        <View style={{
          backgroundColor: "#ffffff", paddingHorizontal: 16, paddingVertical: 10,
          borderBottomWidth: 1, borderBottomColor: "#e8eaed",
          flexDirection: "row", alignItems: "center", gap: 10,
        }}>
          {activeAsset?.color ? (
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: activeAsset.color }} />
          ) : null}
          <Text style={[txt(800), { fontSize: 15, color: "#202124", flex: 1 }]}>
            {activeAsset
              ? `${activeAsset.name}${activeAsset.unit ? ` · #${activeAsset.unit}` : ""}`
              : "—"}
          </Text>
        </View>
      ) : null}

      {isSearching ? (
        // Search results list — replaces the calendar pager while searching.
        <ScrollView
          style={{ flex: 1, backgroundColor: "#f8f9fa" }}
          contentContainerStyle={{ padding: 16, paddingBottom: 120 + insets.bottom }}
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
      ) : assetsLoading || loadsLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#ffffff" }}>
          <ActivityIndicator size="large" color="#1a73e8" />
        </View>
      ) : visibleAssets.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#ffffff", padding: 24 }}>
          <Text style={[txt(700), { fontSize: 15, color: "#3c4043", textAlign: "center" }]}>No assets configured for this org.</Text>
        </View>
      ) : (
        <ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onMomentumScrollEnd={(e) => {
            const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
            setAssetIdx(idx);
            const newAsset = visibleAssets[idx];
            if (newAsset) {
              const ref = pageScrollRefs.current.get(newAsset.id);
              ref?.scrollTo({ x: 0, y: sharedScrollY.current, animated: false });
            }
          }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { refetch(); refetchAssets(); }} tintColor="#1a73e8" />}
          style={{ flex: 1 }}
        >
          {visibleAssets.map((asset) => (
            <AssetPage
              key={asset.id}
              asset={asset}
              dateKey={dateKey}
              loads={loads}
              width={SCREEN_W}
              sharedScrollY={sharedScrollY}
              registerRef={registerPageRef}
            />
          ))}
        </ScrollView>
      )}

      <AssetSidePanel
        visible={panelOpen}
        onClose={() => setPanelOpen(false)}
        allAssets={assets}
        effectiveOrder={orderedIds}
        hiddenIds={prefs.hidden}
        onToggleHidden={setHidden}
        onSetAllHidden={setAllHidden}
        onMove={move}
      />

      <DatePickerModal
        visible={datePickerOpen}
        selected={dateKey}
        onClose={() => setDatePickerOpen(false)}
        onSelect={(d) => setDateKey(d)}
      />

      {/* Floating search FAB — bottom-right when collapsed */}
      {!searchOpen ? (
        <TouchableOpacity
          onPress={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }}
          activeOpacity={0.85}
          style={{
            position: "absolute",
            bottom: insets.bottom + 18, right: 18,
            width: 52, height: 52, borderRadius: 26,
            backgroundColor: "#1a73e8",
            alignItems: "center", justifyContent: "center",
            shadowColor: "#1a73e8", shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
          }}
        >
          <Search size={22} color="#ffffff" strokeWidth={2.4} />
        </TouchableOpacity>
      ) : null}

      {/* Floating search pill — bottom-anchored when expanded */}
      {searchOpen ? (
        <View style={{
          position: "absolute",
          bottom: insets.bottom + 14,
          left: 14, right: 14,
          flexDirection: "row", alignItems: "center", gap: 10,
          paddingHorizontal: 16, paddingVertical: 12,
          backgroundColor: "#ffffff",
          borderRadius: 999,
          borderWidth: 1, borderColor: "#e8eaed",
          shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
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
          <TouchableOpacity
            onPress={() => { setSearchQuery(""); setSearchOpen(false); }}
            hitSlop={8}
            style={{
              width: 26, height: 26, borderRadius: 13,
              backgroundColor: "#f1f3f4",
              alignItems: "center", justifyContent: "center",
            }}
          >
            <X size={14} color="#5f6368" strokeWidth={2.6} />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}
