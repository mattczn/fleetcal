import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Dimensions, ActivityIndicator,
  TextInput, Keyboard, Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { useQuery } from "@tanstack/react-query";
import { useUser, useAuth, useOrganization } from "@clerk/clerk-expo";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, CalendarCheck, Menu, Calendar as CalendarIcon, Search, X, ArrowLeft, List as ListIcon, LayoutGrid, Truck } from "lucide-react-native";
import { fetchAssets, fetchLoadsForDay, searchLoads } from "@/lib/api";
import { txt } from "@/lib/font";
import { lighten, readableOn } from "@/lib/color";
import { useAssetPrefs } from "@/lib/useAssetPrefs";
import { useDebounce } from "@/lib/useDebounce";
import {
  useOrgTimezone,
  todayKeyInTz,
  todayKeyDeviceLocal,
  nowPartsInTz,
} from "@/lib/timezone";
import { AssetSidePanel } from "@/components/AssetSidePanel";
import { DatePickerModal } from "@/components/DatePickerModal";
import { LoadResultCard } from "@/components/LoadResultCard";
import {
  STATUS_TINT, STATUS_LABEL, showStatusPill,
  fmtTimeRangeShort, loadNumLabel, fmtPrice, RelayChip, DiagonalStripes, NonRevChip,
} from "@/lib/loadCard";
import type { Asset, Load } from "@/lib/types";

type ViewMode = "calendar" | "schedule" | "timeline";
const VIEW_MODE_KEY = "fleetcal.dispatch.calendar.viewMode";

/** Timeline-view geometry. Hour columns are wide enough to read a 2-line
 *  card; rows have a BASE height per card (fits title / driver / price on
 *  3 lines), and grow taller when loads overlap so each card keeps its
 *  full base height instead of squishing. Asset-name column on the left
 *  is pinned (doesn't scroll horizontally with the grid) and wide enough
 *  to fit a two-line truck name without truncating. */
const TIMELINE_HOUR_WIDTH      = 80;
const TIMELINE_BASE_ROW_HEIGHT = 76;
const TIMELINE_ASSET_W         = 96;
const TIMELINE_RULER_H         = 28;

/** Stable empty-loads ref — handed to assets with nothing scheduled so the
 *  AssetPage React.memo doesn't see a fresh `[]` every render. */
const EMPTY_LOADS: Load[] = [];

const HOUR_HEIGHT      = 60;
const HOUR_LABEL_WIDTH = 56;

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Today's YYYY-MM-DD in the given IANA timezone, or device-local if
 *  `tz` is null/undefined (fallback used until the org TZ query resolves
 *  or when the org has no TZ configured). */
function todayKey(tz: string | null): string {
  return tz ? todayKeyInTz(tz) : todayKeyDeviceLocal();
}

function shiftKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Header label — "Today · Fri, May 29" if dateKey is today (in the
 *  org's TZ), "Tomorrow / Yesterday · …" for adjacent days, otherwise
 *  the readable date alone. Comparisons happen on date-key strings, so
 *  the readable formatting can stay device-local without skewing
 *  "today/tomorrow/yesterday" detection. */
function fmtHeader(dateKey: string, tz: string | null): string {
  const todayK = todayKey(tz);
  const tmrwK  = shiftKey(todayK, 1);
  const yestK  = shiftKey(todayK, -1);
  const d = new Date(`${dateKey}T00:00:00`);
  const todayDateForYearCheck = new Date(`${todayK}T00:00:00`);
  const date = d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    year: todayDateForYearCheck.getFullYear() !== d.getFullYear() ? "numeric" : undefined,
  });
  if (dateKey === todayK) return `Today · ${date}`;
  if (dateKey === tmrwK)  return `Tomorrow · ${date}`;
  if (dateKey === yestK)  return `Yesterday · ${date}`;
  return date;
}

interface PositionedLoad {
  load:        Load;
  top:         number;  // px
  height:      number;
  spansBefore: boolean; // event started yesterday or earlier
  spansAfter:  boolean; // event ends tomorrow or later
  lane:        number;  // 0-indexed lane within the overlap cluster
  laneCount:   number;  // total parallel lanes used by this load's cluster
}

/**
 * Map a load's start/end (naive YYYY-MM-DDTHH:mm) onto the 24h timeline of
 * `dateKey`, clipping if the load extends outside the day. `lane` and
 * `laneCount` are filled in later by `assignLanes`.
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
    lane: 0, laneCount: 1,
  };
}

/**
 * Google-Calendar-style overlap layout: group transitively-overlapping loads
 * into clusters, then greedily assign each load to the lowest free lane in
 * its cluster. Each cluster's `laneCount` is the max lanes used so every
 * load in a 3-way pile-up renders as a third-width column, while a 2-way
 * overlap yields two half-width columns, and singletons stay full-width.
 */
function assignLanes(positions: PositionedLoad[]): PositionedLoad[] {
  if (positions.length <= 1) return positions;
  const sorted = [...positions].sort(
    (a, b) => a.top - b.top || (b.height - a.height),
  );

  const clusters: PositionedLoad[][] = [];
  let cur: PositionedLoad[] = [];
  let curMaxBottom = -Infinity;
  for (const p of sorted) {
    if (cur.length > 0 && p.top < curMaxBottom) {
      cur.push(p);
      curMaxBottom = Math.max(curMaxBottom, p.top + p.height);
    } else {
      if (cur.length > 0) clusters.push(cur);
      cur = [p];
      curMaxBottom = p.top + p.height;
    }
  }
  if (cur.length > 0) clusters.push(cur);

  const out: PositionedLoad[] = [];
  for (const cluster of clusters) {
    const laneEnds: number[] = []; // bottom y of last item placed in each lane
    const placed: { p: PositionedLoad; lane: number }[] = [];
    for (const p of cluster) {
      let lane = laneEnds.findIndex((end) => end <= p.top);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(p.top + p.height);
      } else {
        laneEnds[lane] = p.top + p.height;
      }
      placed.push({ p, lane });
    }
    const laneCount = laneEnds.length;
    for (const { p, lane } of placed) {
      out.push({ ...p, lane, laneCount });
    }
  }
  return out;
}

function LoadBlock({
  p, assetColor, pageWidth,
}: {
  p:         PositionedLoad;
  assetColor?: string;
  pageWidth: number;
}) {
  const router = useRouter();
  const stripe   = assetColor ?? "#1a73e8";
  const bg       = lighten(assetColor ?? "#1a73e8", 0.82);
  const titleFg  = readableOn(assetColor);
  const spans    = p.spansBefore || p.spansAfter;
  const price    = fmtPrice(p.load.loadPrice);
  const isNonRev = p.load.eventKind === "non_revenue";

  // Lay loads out across the available canvas. With one lane we just use
  // full width; with N>1 lanes each lane is 1/N of the canvas with a small
  // gap between, so a 3-way overlap reads as three side-by-side columns.
  const canvasLeft  = HOUR_LABEL_WIDTH + 6;
  const canvasRight = 8;
  const canvasW     = Math.max(0, pageWidth - canvasLeft - canvasRight);
  const gap         = p.laneCount > 1 ? 3 : 0;
  const laneWidth   = (canvasW - gap * (p.laneCount - 1)) / p.laneCount;
  const left        = canvasLeft + p.lane * (laneWidth + gap);

  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: p.load.id } })}
      activeOpacity={0.85}
      style={{
        position: "absolute", top: p.top, height: p.height,
        left, width: laneWidth,
        backgroundColor: bg,
        borderLeftWidth: 4, borderLeftColor: stripe,
        borderRadius: 8, padding: 6, overflow: "hidden",
      }}
    >
      {isNonRev ? <DiagonalStripes /> : null}
      {spans ? (
        <Text style={[txt(800), { fontSize: 10, color: stripe, letterSpacing: 0.4, marginBottom: 1 }]} numberOfLines={1}>
          CONTINUES
        </Text>
      ) : null}
      <Text style={[txt(800), { fontSize: 13, color: titleFg }]} numberOfLines={2}>
        {p.load.title}
      </Text>
      {(isNonRev || p.load.relayRole) ? (
        <View style={{ flexDirection: "row", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
          {isNonRev ? <NonRevChip size="small" /> : null}
          {p.load.relayRole ? <RelayChip role={p.load.relayRole} size="small" /> : null}
        </View>
      ) : null}
      {p.height >= 48 && p.load.driverName ? (
        <Text style={[txt(600), { fontSize: 11, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
          {p.load.driverName}
        </Text>
      ) : null}
      {p.height >= 60 ? (
        <>
          <Text style={[txt(600), { fontSize: 10, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
            {fmtTimeRangeShort(p.load)}
          </Text>
          <Text style={[txt(600), { fontSize: 10, color: "#3c4043" }]} numberOfLines={1}>
            {loadNumLabel(p.load)}
          </Text>
          {price ? (
            <Text style={[txt(700), { fontSize: 10, color: "#15803d" }]} numberOfLines={1}>
              {price}
            </Text>
          ) : null}
        </>
      ) : null}
    </TouchableOpacity>
  );
}

/**
 * Schedule view card. Per-asset (so we don't repeat the asset name); shows
 * Title → relay (if any) → Driver → Load # · Times · Price. Status pill
 * only when status diverges from the default "scheduled".
 */
function ScheduleCard({ load, assetColor }: { load: Load; assetColor?: string }) {
  const router = useRouter();
  const stripe = assetColor ?? "#1a73e8";
  const bg     = lighten(assetColor ?? "#1a73e8", 0.82);
  const titleFg = readableOn(assetColor);
  const tint   = STATUS_TINT[load.status];
  const price  = fmtPrice(load.loadPrice);
  const isNonRev = load.eventKind === "non_revenue";
  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: load.id } })}
      activeOpacity={0.85}
      style={{
        backgroundColor: bg,
        borderLeftWidth: 4, borderLeftColor: stripe,
        borderRadius: 10,
        marginBottom: 10,
        padding: 12,
        overflow: "hidden",
      }}
    >
      {isNonRev ? <DiagonalStripes /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text style={[txt(800), { fontSize: 14, color: titleFg, flex: 1 }]} numberOfLines={1}>
          {load.title}
        </Text>
        {isNonRev ? <NonRevChip /> : null}
        {load.relayRole ? <RelayChip role={load.relayRole} /> : null}
      </View>
      {load.driverName ? (
        <Text style={[txt(600), { fontSize: 12, color: "#3c4043", marginTop: 3 }]} numberOfLines={1}>
          {load.driverName}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", marginTop: 6 }}>
        <View style={{ flex: 1 }}>
          <Text style={[txt(600), { fontSize: 11, color: "#5f6368" }]} numberOfLines={1}>
            {fmtTimeRangeShort(load)}
          </Text>
          <Text style={[txt(700), { fontSize: 11, color: stripe, marginTop: 2 }]} numberOfLines={1}>
            {loadNumLabel(load)}
          </Text>
          {price ? (
            <Text style={[txt(700), { fontSize: 11, color: "#15803d", marginTop: 2 }]} numberOfLines={1}>
              {price}
            </Text>
          ) : null}
        </View>
        {showStatusPill(load.status) ? (
          <View style={{ paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, backgroundColor: tint.bg }}>
            <Text style={[txt(800), { fontSize: 9, color: tint.fg, letterSpacing: 0.3 }]}>
              {STATUS_LABEL[load.status]}
            </Text>
          </View>
        ) : null}
      </View>
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

function NowLine({ dateKey, tz }: { dateKey: string; tz: string | null }) {
  const [now, setNow] = useState(new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  // Both the "is the viewed day TODAY?" check and the Y-offset use
  // org-TZ-aware time so the line lands at the right position for a
  // dispatcher running on a phone in a different region than the org.
  const todayK = tz ? todayKeyInTz(tz, now) : todayKeyDeviceLocal(now);
  if (todayK !== dateKey) return null;
  const parts = tz
    ? nowPartsInTz(tz, now)
    : { hours: now.getHours(), minutes: now.getMinutes() };
  const top = ((parts.hours * 60 + parts.minutes) / 60) * HOUR_HEIGHT;
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
  /** Pre-sliced — only this asset's loads. Stable reference across renders
   *  when the parent's `loads` query result hasn't changed, so React.memo
   *  below skips re-rendering off-screen pages during a swipe. */
  assetLoads: Load[];
  width:    number;
  viewMode: ViewMode;
  /** Org's IANA timezone for the now-line; null means fall back to device. */
  tz:       string | null;
  /** Mutable Y offset shared across all pages — updated on scroll, applied on swipe-in. */
  sharedScrollY: React.MutableRefObject<number>;
  /** Register this page's ScrollView ref so the parent can scroll it on swipe-in. */
  registerRef:   (id: number, ref: ScrollView | null) => void;
  /** Push this page's vertical scroll position to all other pages so the
   *  next asset is already at the same time of day before the swipe completes. */
  syncScrollY:   (sourceId: number, y: number) => void;
}

const AssetPage = React.memo(function AssetPage({
  asset, dateKey, assetLoads, width, viewMode, tz, sharedScrollY, registerRef, syncScrollY,
}: AssetPageProps) {
  const positioned = useMemo(
    () => assignLanes(
      assetLoads
        .map((l) => positionFor(l, dateKey))
        .filter((p): p is PositionedLoad => p !== null),
    ),
    [assetLoads, dateKey],
  );

  const scheduleList = useMemo(
    () => [...assetLoads].sort((a, b) => a.start.localeCompare(b.start)),
    [assetLoads],
  );

  if (viewMode === "schedule") {
    return (
      <View style={{ width, flex: 1 }}>
        <ScrollView
          style={{ flex: 1, backgroundColor: "#f8f9fa" }}
          contentContainerStyle={{ padding: 14, paddingBottom: 120 }}
          keyboardShouldPersistTaps="handled"
        >
          {scheduleList.length === 0 ? (
            <View style={{ paddingVertical: 60, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                Nothing scheduled for this day.
              </Text>
            </View>
          ) : (
            scheduleList.map((l) => (
              <ScheduleCard key={l.id} load={l} assetColor={asset.color} />
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ width, flex: 1 }}>
      <ScrollView
        ref={(r) => registerRef(asset.id, r)}
        style={{ flex: 1, backgroundColor: "#ffffff" }}
        contentContainerStyle={{ paddingBottom: 40 }}
        scrollEventThrottle={16}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          sharedScrollY.current = y;
          // Mirror to every other page so the next asset is already at
          // the right time of day before the horizontal swipe finishes.
          syncScrollY(asset.id, y);
        }}
        contentOffset={{ x: 0, y: sharedScrollY.current }}
      >
        <View style={{ position: "relative" }}>
          <HourGrid />
          {positioned.map((p) => (
            <LoadBlock key={p.load.id} p={p} assetColor={asset.color} pageWidth={width} />
          ))}
          <NowLine dateKey={dateKey} tz={tz} />
        </View>
      </ScrollView>
    </View>
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Timeline view — rows = assets, columns = hours. Horizontal scroll within
// a day; day changes via the existing header controls. Pinned asset-name
// column on the left scrolls vertically in sync with the grid body.
// ─────────────────────────────────────────────────────────────────────────

interface TimelinePositioned {
  load:        Load;
  left:        number;  // px from start of day (00:00)
  width:       number;  // px
  spansBefore: boolean;
  spansAfter:  boolean;
  lane:        number;  // 0-indexed sub-lane within an overlap cluster
  laneCount:   number;
}

/** Map a load's start/end onto the horizontal 24h timeline for `dateKey`.
 *  Clips to the day if the load spans midnight. Returns null if the load
 *  doesn't intersect the day at all. Mirrors `positionFor` but in x. */
function positionForTimeline(load: Load, dateKey: string): TimelinePositioned | null {
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
  const left     = (startMin / 60) * TIMELINE_HOUR_WIDTH;
  const width    = Math.max(((endMin - startMin) / 60) * TIMELINE_HOUR_WIDTH, 40);

  return {
    load, left, width,
    spansBefore: dateKey !== startKey,
    spansAfter:  dateKey !== endKey,
    lane: 0, laneCount: 1,
  };
}

/** Horizontal twin of `assignLanes` (which operates on top/height). Groups
 *  transitively-overlapping loads on a single asset's row into clusters,
 *  then assigns each to a vertical sub-lane within the row so a relay
 *  handoff that briefly overlaps reads as two stacked half-height cards. */
function assignLanesTimeline(positions: TimelinePositioned[]): TimelinePositioned[] {
  if (positions.length <= 1) return positions;
  const sorted = [...positions].sort(
    (a, b) => a.left - b.left || (b.width - a.width),
  );

  const clusters: TimelinePositioned[][] = [];
  let cur: TimelinePositioned[] = [];
  let curMaxRight = -Infinity;
  for (const p of sorted) {
    if (cur.length > 0 && p.left < curMaxRight) {
      cur.push(p);
      curMaxRight = Math.max(curMaxRight, p.left + p.width);
    } else {
      if (cur.length > 0) clusters.push(cur);
      cur = [p];
      curMaxRight = p.left + p.width;
    }
  }
  if (cur.length > 0) clusters.push(cur);

  const out: TimelinePositioned[] = [];
  for (const cluster of clusters) {
    const laneEnds: number[] = [];
    const placed: { p: TimelinePositioned; lane: number }[] = [];
    for (const p of cluster) {
      let lane = laneEnds.findIndex((end) => end <= p.left);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(p.left + p.width);
      } else {
        laneEnds[lane] = p.left + p.width;
      }
      placed.push({ p, lane });
    }
    const laneCount = laneEnds.length;
    for (const { p, lane } of placed) {
      out.push({ ...p, lane, laneCount });
    }
  }
  return out;
}

/** Minimal load card for the timeline grid — title, driver, $, relay P/D
 *  pill, asset-color stripe. Always renders at full base height. When
 *  loads overlap on the same row, the *row* grows to fit (handled by
 *  TimelineAssetRow); the card itself doesn't shrink. */
function TimelineLoadBlock({
  p, assetColor,
}: {
  p:          TimelinePositioned;
  assetColor?: string;
}) {
  const router  = useRouter();
  const stripe  = assetColor ?? "#1a73e8";
  const bg      = lighten(assetColor ?? "#1a73e8", 0.82);
  const titleFg = readableOn(assetColor);
  const price   = fmtPrice(p.load.loadPrice);
  const isNonRev = p.load.eventKind === "non_revenue";

  // Each card sits in its own lane row. Row height per lane = base; the
  // card is base minus a 4px top/bottom margin so adjacent cards visually
  // separate.
  const blockTop    = p.lane * TIMELINE_BASE_ROW_HEIGHT + 4;
  const blockHeight = TIMELINE_BASE_ROW_HEIGHT - 8;

  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: p.load.id } })}
      activeOpacity={0.85}
      style={{
        position: "absolute",
        left: p.left + 2, width: Math.max(p.width - 4, 36),
        top:  blockTop,   height: blockHeight,
        backgroundColor: bg,
        borderLeftWidth: 3, borderLeftColor: stripe,
        borderRadius: 6,
        paddingHorizontal: 6, paddingVertical: 4,
        overflow: "hidden",
      }}
    >
      {isNonRev ? <DiagonalStripes /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={[txt(800), { fontSize: 12, color: titleFg, flex: 1 }]} numberOfLines={1}>
          {p.load.title}
        </Text>
        {p.load.relayRole ? <RelayChip role={p.load.relayRole} size="small" /> : null}
        {isNonRev ? <NonRevChip size="small" /> : null}
      </View>
      {p.load.driverName ? (
        <Text style={[txt(600), { fontSize: 11, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
          {p.load.driverName}
        </Text>
      ) : null}
      {price ? (
        <Text style={[txt(700), { fontSize: 11, color: "#15803d", marginTop: 1 }]} numberOfLines={1}>
          {price}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

/** Hour ruler — labels are absolute-positioned so each label's horizontal
 *  CENTER sits exactly on its corresponding gridline x in the body grid
 *  below (gridlines render at h * HOUR_WIDTH for h = 1..23). For h=0
 *  ("12 AM") there is no gridline at x=0, so we left-anchor it so it
 *  doesn't half-clip off the start of the timeline. Scrolls horizontally
 *  in lockstep with the grid body via synced ScrollView refs. */
function TimelineHourRuler() {
  const LABEL_W = 56;
  return (
    <View style={{
      position: "relative",
      width: 24 * TIMELINE_HOUR_WIDTH,
      height: TIMELINE_RULER_H,
      backgroundColor: "#f8f9fa",
      borderBottomWidth: 1,
      borderBottomColor: "#e8eaed",
    }}>
      {Array.from({ length: 24 }, (_, h) => {
        const ampm = h >= 12 ? "PM" : "AM";
        const hh   = h % 12 || 12;
        const label = `${hh}${h === 0 ? "" : ` ${ampm}`}`;
        const isFirst = h === 0;
        return (
          <View
            key={h}
            style={{
              position: "absolute",
              top: 0,
              height: TIMELINE_RULER_H,
              left:  isFirst ? 0 : h * TIMELINE_HOUR_WIDTH - LABEL_W / 2,
              width: LABEL_W,
              alignItems:     isFirst ? "flex-start" : "center",
              justifyContent: "center",
              paddingLeft:    isFirst ? 6 : 0,
            }}
          >
            <Text style={[txt(700), { fontSize: 11, color: "#9aa0a6" }]}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Vertical now-line for the timeline (red bar at current time). Hidden
 *  when the viewed day isn't today (in the org's timezone). */
function TimelineNowLine({ dateKey, tz }: { dateKey: string; tz: string | null }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const todayK = tz ? todayKeyInTz(tz, now) : todayKeyDeviceLocal(now);
  if (todayK !== dateKey) return null;
  const parts = tz
    ? nowPartsInTz(tz, now)
    : { hours: now.getHours(), minutes: now.getMinutes() };
  const left = ((parts.hours * 60 + parts.minutes) / 60) * TIMELINE_HOUR_WIDTH;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0, bottom: 0,
        left,
        width: 2,
        backgroundColor: "#ea4335",
      }}
    >
      <View style={{
        position: "absolute",
        top: -3, left: -3,
        width: 8, height: 8, borderRadius: 4,
        backgroundColor: "#ea4335",
      }} />
    </View>
  );
}

/** Single asset's row on the timeline grid. Receives pre-positioned loads
 *  (with lane assignments) + a row height computed by the parent so the
 *  pinned asset-name cell can match — overlapping loads make the row
 *  taller, but each card stays at its base height. */
function TimelineAssetRow({
  asset, positioned, height,
}: {
  asset:      Asset;
  positioned: TimelinePositioned[];
  height:     number;
}) {
  return (
    <View style={{
      position: "relative",
      width: 24 * TIMELINE_HOUR_WIDTH,
      height,
      borderBottomWidth: 1,
      borderBottomColor: "#f1f3f4",
    }}>
      {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
        <View
          key={h}
          style={{
            position: "absolute",
            left: h * TIMELINE_HOUR_WIDTH,
            top: 0, bottom: 0,
            width: 1,
            backgroundColor: "#f6f7f9",
          }}
        />
      ))}
      {positioned.map((p) => (
        <TimelineLoadBlock key={p.load.id} p={p} assetColor={asset.color} />
      ))}
    </View>
  );
}

/** Pinned asset-name cell for the left column. Lucide truck icon tinted
 *  with the asset color on top, truck name centered below (no unit). Cell
 *  height matches the corresponding grid row so the two scroll views stay
 *  aligned even when a row grows to fit overlapping loads. */
function TimelineAssetNameCell({ asset, height }: { asset: Asset; height: number }) {
  return (
    <View style={{
      width: TIMELINE_ASSET_W,
      height,
      borderBottomWidth: 1,
      borderBottomColor: "#f1f3f4",
      borderRightWidth: 1,
      borderRightColor: "#e8eaed",
      paddingHorizontal: 4, paddingVertical: 4,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      backgroundColor: "#ffffff",
    }}>
      <Truck size={18} color={asset.color ?? "#1a73e8"} strokeWidth={2.2} />
      <Text
        style={[txt(700), { fontSize: 11, color: "#202124", textAlign: "center", lineHeight: 13 }]}
        numberOfLines={2}
      >
        {asset.name}
      </Text>
    </View>
  );
}

/**
 * Timeline grid. Two pairs of synced ScrollViews:
 *   - horizontal: body grid drives the hour ruler (ruler is scrollEnabled
 *     false; receives programmatic scrollTo on body onScroll).
 *   - vertical:   body grid drives the pinned asset column (same pattern).
 *
 * Lands the user at 6 AM on first mount so they don't have to swipe
 * through 6 empty overnight hours every time they open the view.
 */
function TimelineView({
  visibleAssets, loadsByAsset, dateKey, tz,
}: {
  visibleAssets: Asset[];
  loadsByAsset:  Map<number, Load[]>;
  dateKey:       string;
  tz:            string | null;
}) {
  const hBodyRef   = useRef<ScrollView>(null);
  const hHeaderRef = useRef<ScrollView>(null);
  const vBodyRef   = useRef<ScrollView>(null);
  const vLeftRef   = useRef<ScrollView>(null);

  // Per-asset row layout — positioned + lane-assigned loads plus the
  // resulting row height. Row height = base × maxLanes-on-this-row, so a
  // row with a 2-load overlap is 2× tall and every card keeps full base
  // height. Computed once per (assets, loads, day) and shared with both
  // the pinned asset column and the grid body so heights stay aligned.
  const rowLayouts = useMemo(() => {
    const m = new Map<number, { positioned: TimelinePositioned[]; height: number }>();
    for (const a of visibleAssets) {
      const positioned = assignLanesTimeline(
        (loadsByAsset.get(a.id) ?? EMPTY_LOADS)
          .map((l) => positionForTimeline(l, dateKey))
          .filter((p): p is TimelinePositioned => p !== null),
      );
      const maxLanes = positioned.reduce((mx, p) => Math.max(mx, p.laneCount), 1);
      m.set(a.id, { positioned, height: TIMELINE_BASE_ROW_HEIGHT * maxLanes });
    }
    return m;
  }, [visibleAssets, loadsByAsset, dateKey]);

  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (initialScrollDone.current) return;
    const x = 6 * TIMELINE_HOUR_WIDTH;
    setTimeout(() => {
      hBodyRef.current?.scrollTo({ x, animated: false });
      hHeaderRef.current?.scrollTo({ x, animated: false });
    }, 50);
    initialScrollDone.current = true;
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
      {/* Header row: empty top-left corner + horizontally-scrolling hour ruler */}
      <View style={{ flexDirection: "row" }}>
        <View style={{
          width: TIMELINE_ASSET_W,
          height: TIMELINE_RULER_H,
          backgroundColor: "#f8f9fa",
          borderBottomWidth: 1, borderBottomColor: "#e8eaed",
          borderRightWidth: 1,  borderRightColor: "#e8eaed",
        }} />
        <ScrollView
          ref={hHeaderRef}
          horizontal
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
        >
          <TimelineHourRuler />
        </ScrollView>
      </View>

      {/* Body: pinned asset column (vertical-only) + 2D-scrolling grid */}
      <View style={{ flex: 1, flexDirection: "row" }}>
        <ScrollView
          ref={vLeftRef}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          style={{ width: TIMELINE_ASSET_W }}
          contentContainerStyle={{ paddingBottom: 120 }}
        >
          {visibleAssets.map((a) => {
            const layout = rowLayouts.get(a.id);
            return (
              <TimelineAssetNameCell
                key={a.id}
                asset={a}
                height={layout?.height ?? TIMELINE_BASE_ROW_HEIGHT}
              />
            );
          })}
        </ScrollView>

        <ScrollView
          ref={hBodyRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(e) => {
            const x = e.nativeEvent.contentOffset.x;
            hHeaderRef.current?.scrollTo({ x, animated: false });
          }}
        >
          <ScrollView
            ref={vBodyRef}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            nestedScrollEnabled
            onScroll={(e) => {
              const y = e.nativeEvent.contentOffset.y;
              vLeftRef.current?.scrollTo({ y, animated: false });
            }}
            contentContainerStyle={{ paddingBottom: 120 }}
          >
            <View style={{ width: 24 * TIMELINE_HOUR_WIDTH, position: "relative" }}>
              {visibleAssets.map((a) => {
                const layout = rowLayouts.get(a.id);
                return (
                  <TimelineAssetRow
                    key={a.id}
                    asset={a}
                    positioned={layout?.positioned ?? []}
                    height={layout?.height ?? TIMELINE_BASE_ROW_HEIGHT}
                  />
                );
              })}
              <TimelineNowLine dateKey={dateKey} tz={tz} />
            </View>
          </ScrollView>
        </ScrollView>
      </View>
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

  // Org timezone — load times are already stored in org-local "naive"
  // strings, but anything derived from `new Date()` (the now-line, the
  // "today" the calendar opens on) needs to honor the org clock, not the
  // dispatcher's phone. Falls back to device TZ until the query resolves.
  const { tz: orgTz } = useOrgTimezone();

  // Init with device-local today (TZ may not be resolved yet on first
  // render). One-shot effect below snaps to org-today once the TZ loads,
  // but only if the user hasn't already navigated to a different day.
  const [dateKey, setDateKey] = useState(() => todayKey(orgTz));
  const tzSnappedRef = useRef(false);
  React.useEffect(() => {
    if (tzSnappedRef.current || !orgTz) return;
    const orgToday    = todayKeyInTz(orgTz);
    const deviceToday = todayKeyDeviceLocal();
    if (dateKey === deviceToday && deviceToday !== orgToday) {
      setDateKey(orgToday);
    }
    tzSnappedRef.current = true;
    // Only depend on orgTz — we want this to fire exactly once when the
    // TZ becomes known, not every time dateKey changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgTz]);
  const [assetIdx, setAssetIdx] = useState(0);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<TextInput>(null);
  const pagerRef = useRef<ScrollView>(null);

  // Track keyboard height so the floating search pill can hop above it
  // when focused. RN doesn't push absolute-positioned views up for the
  // keyboard, so we adjust `bottom` manually on show/hide.
  //
  // The pill is positioned inside the tab navigator's screen view, whose
  // bottom edge is already above the tab bar. Subtracting the tab bar
  // height from the keyboard height gives the lift the pill needs to
  // sit just above the keyboard (no gap).
  const tabBarHeight = useBottomTabBarHeight();
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = (e: any) => setKbHeight(e?.endCoordinates?.height ?? 0);
    const onHide = () => setKbHeight(0);
    const s = Keyboard.addListener(showEvt, onShow);
    const h = Keyboard.addListener(hideEvt, onHide);
    return () => { s.remove(); h.remove(); };
  }, []);
  const kbLift = Math.max(0, kbHeight - tabBarHeight);

  // Calendar (hourly grid) vs Schedule (card list) — persisted in AsyncStorage
  // so the user's choice survives app restarts.
  const [viewMode, setViewMode] = useState<ViewMode>("calendar");
  const viewLoaded = useRef(false);
  React.useEffect(() => {
    AsyncStorage.getItem(VIEW_MODE_KEY).then((v) => {
      if (v === "calendar" || v === "schedule" || v === "timeline") setViewMode(v);
      viewLoaded.current = true;
    }).catch(() => { viewLoaded.current = true; });
  }, []);
  React.useEffect(() => {
    if (!viewLoaded.current) return;
    AsyncStorage.setItem(VIEW_MODE_KEY, viewMode).catch(() => {});
  }, [viewMode]);

  // Shared vertical scroll position across all asset pages — preserves the
  // 6am-12pm view (or wherever the dispatcher is looking) when swiping assets.
  const sharedScrollY = useRef(0);
  const pageScrollRefs = useRef<Map<number, ScrollView | null>>(new Map());
  const registerPageRef = React.useCallback((id: number, ref: ScrollView | null) => {
    pageScrollRefs.current.set(id, ref);
  }, []);
  // Live propagator — when the active page scrolls vertically, mirror the
  // offset onto every other registered page so the new asset is already at
  // the right time of day before the user finishes a horizontal swipe.
  // Only the page id matching `activeAssetIdRef` is allowed to propagate;
  // otherwise the programmatic scrollTo on each receiver fires its own
  // onScroll which calls back into us → infinite scroll battle.
  const activeAssetIdRef = useRef<number | null>(null);
  const syncScrollY = React.useCallback((sourceId: number, y: number) => {
    if (sourceId !== activeAssetIdRef.current) return;
    for (const [id, ref] of pageScrollRefs.current) {
      if (id !== sourceId && ref) {
        ref.scrollTo({ x: 0, y, animated: false });
      }
    }
  }, []);

  const { data: assets = [], isLoading: assetsLoading } = useQuery({
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
  //
  // Always re-jump on a fresh requestedAssetId — the previous one-shot
  // jumpedRef.current guard left a still-mounted screen stuck on the
  // previous asset when the user picked a different one from Home. After
  // jumping, consume the URL param via router.setParams so re-navigating
  // to the SAME asset later (after a manual swipe to a different truck)
  // shows up as null → assetId and re-fires the jump.
  React.useEffect(() => {
    if (!requestedAssetId || assets.length === 0) return;
    const target = assets.find((a) => a.id === requestedAssetId);
    if (!target || target.hidden) return;

    if (prefs.hidden.includes(target.id)) {
      setHidden(target.id, false);
      return; // re-runs after prefs update, visibleAssets will include the asset
    }

    const idx = visibleAssets.findIndex((a) => a.id === target.id);
    if (idx < 0) return;
    setAssetIdx(idx);
    setTimeout(() => pagerRef.current?.scrollTo({ x: idx * SCREEN_W, animated: false }), 50);
    router.setParams({ assetId: undefined });
  }, [requestedAssetId, assets, prefs.hidden, visibleAssets, SCREEN_W, setHidden, router]);

  // Remember that the screen was entered with an assetId so the back-arrow
  // chip in the header stays visible after we consume the param above.
  // Without this latch, the arrow would flash off the instant the jump
  // completed.
  const [showBackArrow, setShowBackArrow] = useState(false);
  React.useEffect(() => {
    if (requestedAssetId) setShowBackArrow(true);
  }, [requestedAssetId]);

  const { data: loads = [], isLoading: loadsLoading } = useQuery({
    queryKey: ["loads", orgId, dateKey],
    queryFn:  () => fetchLoadsForDay(orgId!, dateKey),
    enabled:  !!orgId,
  });

  // Pre-slice loads by asset id once per fetch — gives each AssetPage a
  // stable array reference so the React.memo wrapper actually skips
  // re-rendering off-screen pages during a horizontal swipe.
  const loadsByAsset = useMemo(() => {
    const m = new Map<number, Load[]>();
    for (const l of loads) {
      const arr = m.get(l.assetId);
      if (arr) arr.push(l);
      else m.set(l.assetId, [l]);
    }
    return m;
  }, [loads]);

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

  // Keep the propagator's "who's allowed to broadcast" pointer up to
  // date with whichever asset is currently centered in the pager.
  React.useEffect(() => {
    activeAssetIdRef.current = visibleAssets[assetIdx]?.id ?? null;
  }, [assetIdx, visibleAssets]);

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
            ? `Signed in as ${user.primaryEmailAddress.emailAddress}, but you don't have access to a FleetCal organization.`
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
          {showBackArrow ? (
            <TouchableOpacity
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace("/");
              }}
              hitSlop={10}
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
              {fmtHeader(dateKey, orgTz)}
            </Text>
            <CalendarIcon size={14} color="rgba(255,255,255,0.7)" strokeWidth={2.2} />
          </TouchableOpacity>
        </View>

        {/* Date stepper */}
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, gap: 8 }}>
          <TouchableOpacity onPress={() => shiftDate(-1)} hitSlop={8}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }}>
            <ChevronLeft size={16} color="#ffffff" strokeWidth={2.4} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDateKey(todayKey(orgTz))}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: 999 }}>
            <CalendarCheck size={13} color="#ffffff" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 12, color: "#ffffff", letterSpacing: 0.3 }]}>Today</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => shiftDate(1)} hitSlop={8}
            style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center" }}>
            <ChevronRight size={16} color="#ffffff" strokeWidth={2.4} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          {/* Calendar / Schedule view toggle */}
          <View style={{
            flexDirection: "row",
            backgroundColor: "rgba(255,255,255,0.14)",
            borderRadius: 999,
            padding: 2,
          }}>
            <TouchableOpacity
              onPress={() => setViewMode("calendar")}
              activeOpacity={0.85}
              hitSlop={6}
              accessibilityLabel="Calendar view"
              style={{
                width: 28, height: 28, borderRadius: 999,
                alignItems: "center", justifyContent: "center",
                backgroundColor: viewMode === "calendar" ? "#ffffff" : "transparent",
              }}
            >
              <CalendarIcon size={14} color={viewMode === "calendar" ? "#1a73e8" : "#ffffff"} strokeWidth={2.4} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setViewMode("schedule")}
              activeOpacity={0.85}
              hitSlop={6}
              accessibilityLabel="Schedule view"
              style={{
                width: 28, height: 28, borderRadius: 999,
                alignItems: "center", justifyContent: "center",
                backgroundColor: viewMode === "schedule" ? "#ffffff" : "transparent",
              }}
            >
              <ListIcon size={14} color={viewMode === "schedule" ? "#1a73e8" : "#ffffff"} strokeWidth={2.4} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setViewMode("timeline")}
              activeOpacity={0.85}
              hitSlop={6}
              accessibilityLabel="Timeline view"
              style={{
                width: 28, height: 28, borderRadius: 999,
                alignItems: "center", justifyContent: "center",
                backgroundColor: viewMode === "timeline" ? "#ffffff" : "transparent",
              }}
            >
              <LayoutGrid size={14} color={viewMode === "timeline" ? "#1a73e8" : "#ffffff"} strokeWidth={2.4} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Asset name bar — only shown when not actively searching.
          Timeline view shows every asset as its own row, so this header
          (which names the currently-paged asset) doesn't apply there. */}
      {!isSearching && viewMode !== "timeline" ? (
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
        // Extra bottom padding while the keyboard is open so the last
        // result isn't trapped behind the keyboard + floating pill.
        <ScrollView
          style={{ flex: 1, backgroundColor: "#f8f9fa" }}
          contentContainerStyle={{ padding: 16, paddingBottom: 120 + insets.bottom + kbLift }}
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
      ) : viewMode === "timeline" ? (
        // Timeline view: every visible asset gets a row; horizontal scroll
        // moves through the 24 hours of the current day. Day navigation
        // stays on the header (chevrons / Today / date picker).
        <TimelineView
          visibleAssets={visibleAssets}
          loadsByAsset={loadsByAsset}
          dateKey={dateKey}
          tz={orgTz}
        />
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
          style={{ flex: 1 }}
        >
          {visibleAssets.map((asset) => (
            <AssetPage
              key={asset.id}
              asset={asset}
              dateKey={dateKey}
              assetLoads={loadsByAsset.get(asset.id) ?? EMPTY_LOADS}
              width={SCREEN_W}
              viewMode={viewMode}
              tz={orgTz}
              sharedScrollY={sharedScrollY}
              registerRef={registerPageRef}
              syncScrollY={syncScrollY}
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

      {/* Floating search FAB — sits just above the bottom tab bar */}
      {!searchOpen ? (
        <TouchableOpacity
          onPress={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }}
          activeOpacity={0.85}
          style={{
            position: "absolute",
            bottom: 8, right: 14,
            width: 52, height: 52, borderRadius: 26,
            backgroundColor: "#1a73e8",
            alignItems: "center", justifyContent: "center",
            shadowColor: "#1a73e8", shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
          }}
        >
          <Search size={22} color="#ffffff" strokeWidth={2.4} />
        </TouchableOpacity>
      ) : null}

      {/* Floating search pill — sits just above the bottom tab bar when open.
          Lifts above the keyboard when focused (RN doesn't push absolute
          views up automatically). */}
      {searchOpen ? (
        <View style={{
          position: "absolute",
          bottom: 8 + kbLift,
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
