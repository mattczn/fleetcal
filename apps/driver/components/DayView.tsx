import React, { useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, FlatList, Dimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import type { Load } from "@/lib/types";
import { needsConfirmation } from "@/lib/loadStatus";
import {
  RelayChip, NonRevChip, DiagonalStripes,
  fmtTimeRangeShort,
} from "@/lib/loadCard";
import { useDriverSession } from "@/lib/useDriverSession";
import { useOrgTz, nowInTz, todayKeyInTz } from "@/lib/orgTz";
import { legPositionOf } from "@/lib/relayLegs";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const HOUR_HEIGHT       = 60;
const HOUR_LABEL_WIDTH  = 56;
const DAY_RANGE         = 60;
const SCREEN_W          = Dimensions.get("window").width;

function pad(n: number) { return String(n).padStart(2, "0"); }
function dateKeyFromDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Shift a "YYYY-MM-DD" key by N days, anchored on noon to avoid
 *  DST-edge weirdness (a midnight anchor can land on the missing or
 *  duplicate hour at a transition and drift). */
function shiftDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00`);
  d.setDate(d.getDate() + days);
  return dateKeyFromDate(d);
}

/** Header label for a date pane. `todayKey` MUST be passed in by the
 *  caller — derived from the org tz, not the device. Otherwise "Today"
 *  would mean "today in the device's tz" which is the bug we're
 *  killing. */
function fmtDayHeader(dateKey: string, todayKey: string): string {
  const d = new Date(`${dateKey}T12:00:00`);
  const todayD = new Date(`${todayKey}T12:00:00`);
  const dateLabel = d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    year: todayD.getFullYear() !== d.getFullYear() ? "numeric" : undefined,
  });
  if (dateKey === todayKey)                       return `Today · ${dateLabel}`;
  if (dateKey === shiftDateKey(todayKey,  1))     return `Tomorrow · ${dateLabel}`;
  if (dateKey === shiftDateKey(todayKey, -1))     return `Yesterday · ${dateLabel}`;
  return dateLabel;
}

function fmtHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

interface PositionedEvent {
  load: Load; top: number; height: number;
  spansBefore: boolean; spansAfter: boolean;
  lane: number; laneCount: number;
}

function positionFor(load: Load, dateKey: string): PositionedEvent | null {
  const evStartKey = load.start.slice(0, 10);
  const evEndKey   = load.end.slice(0, 10);
  if (evEndKey < dateKey || evStartKey > dateKey) return null;

  const fract = (iso: string): number => {
    const t = iso.slice(11, 16);
    const [h, m] = t.split(":").map((s) => parseInt(s, 10));
    return (isNaN(h) ? 0 : h) + (isNaN(m) ? 0 : m) / 60;
  };

  const startsBefore = evStartKey < dateKey;
  const endsAfter    = evEndKey > dateKey;
  const startHours   = startsBefore ? 0  : fract(load.start);
  const endHours     = endsAfter    ? 24 : fract(load.end);

  return {
    load,
    top:    startHours * HOUR_HEIGHT,
    height: Math.max((endHours - startHours) * HOUR_HEIGHT, 28),
    spansBefore: startsBefore,
    spansAfter:  endsAfter,
    lane: 0, laneCount: 1,
  };
}

/**
 * Google-Calendar-style overlap layout: group transitively-overlapping
 * events into clusters, then greedily assign each to the lowest free
 * lane. Two overlapping events render as 50/50 columns; three pile up
 * as thirds. Singletons stay full-width.
 */
function assignLanes(events: PositionedEvent[]): PositionedEvent[] {
  if (events.length <= 1) return events;
  const sorted = [...events].sort(
    (a, b) => a.top - b.top || (b.height - a.height),
  );

  const clusters: PositionedEvent[][] = [];
  let cur: PositionedEvent[] = [];
  let curMaxBottom = -Infinity;
  for (const ev of sorted) {
    if (cur.length > 0 && ev.top < curMaxBottom) {
      cur.push(ev);
      curMaxBottom = Math.max(curMaxBottom, ev.top + ev.height);
    } else {
      if (cur.length > 0) clusters.push(cur);
      cur = [ev];
      curMaxBottom = ev.top + ev.height;
    }
  }
  if (cur.length > 0) clusters.push(cur);

  const out: PositionedEvent[] = [];
  for (const cluster of clusters) {
    const laneEnds: number[] = [];
    const placed: { ev: PositionedEvent; lane: number }[] = [];
    for (const ev of cluster) {
      let lane = laneEnds.findIndex((end) => end <= ev.top);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(ev.top + ev.height);
      } else {
        laneEnds[lane] = ev.top + ev.height;
      }
      placed.push({ ev, lane });
    }
    const laneCount = laneEnds.length;
    for (const { ev, lane } of placed) {
      out.push({ ...ev, lane, laneCount });
    }
  }
  return out;
}

function HourGrid() {
  return (
    <>
      {Array.from({ length: 24 }, (_, h) => (
        <View key={h}
          style={{ position: "absolute", top: h * HOUR_HEIGHT, left: 0, right: 0, height: HOUR_HEIGHT, borderTopWidth: 1, borderTopColor: "#f1f3f4" }}>
          <Text style={[txt(700), { position: "absolute", top: -7, left: 8, fontSize: 10, color: "#9aa0a6", letterSpacing: 0.3, backgroundColor: "#f8f9fa", paddingHorizontal: 4 }]}>
            {fmtHourLabel(h)}
          </Text>
        </View>
      ))}
      <View style={{ position: "absolute", top: 24 * HOUR_HEIGHT, left: 0, right: 0, height: 1, backgroundColor: "#f1f3f4" }} />
    </>
  );
}

function NowLine({ dateKey, todayKey, orgTz }: { dateKey: string; todayKey: string; orgTz: string | null }) {
  const [, force] = useState(0);
  React.useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (dateKey !== todayKey) return null;
  // Position the red line at the current hour IN THE ORG'S TZ — not
  // the device's. Events are laid out by their naive ISO time-of-day
  // (also org-tz), so this keeps the line aligned with the events.
  const now = nowInTz(orgTz);
  const top = (now.getHours() + now.getMinutes() / 60) * HOUR_HEIGHT;
  return (
    <View style={{ position: "absolute", top, left: HOUR_LABEL_WIDTH - 4, right: 8, zIndex: 10, flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#ea4335", marginLeft: -4 }} />
      <View style={{ flex: 1, height: 2, backgroundColor: "#ea4335" }} />
    </View>
  );
}

function EventBlock({ ev, paneWidth }: { ev: PositionedEvent; paneWidth: number }) {
  const router = useRouter();
  const { load, top, height, spansBefore, spansAfter, lane, laneCount } = ev;
  const needsAction = needsConfirmation(load);
  const isNonRev   = load.eventKind === "non_revenue";
  const legPos     = legPositionOf(load);
  const spans      = spansBefore || spansAfter;
  const stripeColor = needsAction ? "#dc2626" : "#1a73e8";

  // Lane geometry — full width when there's no overlap, equal-width
  // columns with a small gap when 2+ events overlap (Google Calendar
  // pattern). `paneWidth` is the SCREEN_W passed in from DayPane.
  const canvasLeft  = HOUR_LABEL_WIDTH + 6;
  const canvasRight = 8;
  const canvasW     = Math.max(0, paneWidth - canvasLeft - canvasRight);
  const gap         = laneCount > 1 ? 3 : 0;
  const laneWidth   = (canvasW - gap * (laneCount - 1)) / laneCount;
  const left        = canvasLeft + lane * (laneWidth + gap);

  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: load.id } })}
      activeOpacity={0.85}
      style={{
        position: "absolute", top, height,
        left, width: laneWidth,
        backgroundColor: needsAction ? "#fee2e2" : "#e8f0fe",
        borderLeftWidth: 4, borderLeftColor: stripeColor,
        borderRadius: 8, padding: 6, overflow: "hidden",
      }}
    >
      {isNonRev ? <DiagonalStripes /> : null}
      {spans ? (
        <Text style={[txt(800), { fontSize: 10, color: stripeColor, letterSpacing: 0.4, marginBottom: 1 }]} numberOfLines={1}>
          CONTINUES
        </Text>
      ) : null}
      <Text style={[txt(800), { fontSize: 13, color: "#1a3060" }]} numberOfLines={2}>
        {load.title}
      </Text>
      {(isNonRev || legPos) ? (
        <View style={{ flexDirection: "row", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
          {isNonRev ? <NonRevChip size="small" /> : null}
          {legPos ? <RelayChip legIndex={legPos.legIndex} legCount={legPos.legCount} size="small" /> : null}
        </View>
      ) : null}
      {height >= 48 && load.assetName ? (
        <Text style={[txt(600), { fontSize: 11, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
          {load.assetName}
        </Text>
      ) : null}
      {height >= 64 ? (
        <Text style={[txt(600), { fontSize: 10, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
          {fmtTimeRangeShort(load)}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function DayPane({ dateKey, loads, todayKey, orgTz }: {
  dateKey: string;
  loads: Load[];
  todayKey: string;
  orgTz: string | null;
}) {
  const events = useMemo(
    () => assignLanes(
      loads.map((l) => positionFor(l, dateKey)).filter((p): p is PositionedEvent => p !== null),
    ),
    [loads, dateKey],
  );
  const scrollRef = useRef<ScrollView>(null);

  React.useEffect(() => {
    const firstTop = events.length > 0
      ? Math.min(...events.map((e) => e.top))
      : 6 * HOUR_HEIGHT;
    setTimeout(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, firstTop - HOUR_HEIGHT), animated: false });
    }, 50);
  }, [events]);

  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, width: SCREEN_W }}
      contentContainerStyle={{ height: 24 * HOUR_HEIGHT + 20, position: "relative" }}
      showsVerticalScrollIndicator
    >
      <HourGrid />
      <NowLine dateKey={dateKey} todayKey={todayKey} orgTz={orgTz} />
      {events.map((ev) => <EventBlock key={ev.load.id} ev={ev} paneWidth={SCREEN_W} />)}
    </ScrollView>
  );
}

export interface DayViewHandle { goToToday: () => void; }

export const DayView = React.forwardRef<DayViewHandle, { loads: Load[] }>(({ loads }, ref) => {
  // Org tz must drive "today" — otherwise the centered date and the
  // "Today" header refer to the device's local day, which can be one
  // day ahead/behind the org around midnight.
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;
  const orgTz = useOrgTz(driver?.driverId, driver?.orgId);

  const todayKey = useMemo(() => todayKeyInTz(orgTz), [orgTz]);
  const dateKeys = useMemo(() => {
    const out: string[] = [];
    for (let i = -DAY_RANGE; i <= DAY_RANGE; i++) {
      out.push(shiftDateKey(todayKey, i));
    }
    return out;
  }, [todayKey]);
  const todayIndex = DAY_RANGE;
  const [currentIndex, setCurrentIndex] = useState(todayIndex);
  const flatListRef = useRef<FlatList>(null);

  const currentKey = dateKeys[currentIndex];

  React.useImperativeHandle(ref, () => ({
    goToToday: () => flatListRef.current?.scrollToIndex({ index: todayIndex, animated: true }),
  }), [todayIndex]);

  function goPrev() { if (currentIndex > 0) flatListRef.current?.scrollToIndex({ index: currentIndex - 1, animated: true }); }
  function goNext() { if (currentIndex < dateKeys.length - 1) flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true }); }

  return (
    <View style={{ flex: 1 }}>
      {/* Date control bar */}
      <View
        style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: 8, paddingVertical: 10,
          backgroundColor: "#ffffff",
          borderBottomWidth: 1, borderBottomColor: "#e8eaed",
        }}
      >
        <TouchableOpacity onPress={goPrev} activeOpacity={0.6}
          disabled={currentIndex === 0}
          style={{ width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19, opacity: currentIndex === 0 ? 0.3 : 1 }}>
          <ChevronLeft size={20} color="#3c4043" strokeWidth={2.2} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={[txt(800), { fontSize: 15, color: "#202124", letterSpacing: -0.2 }]} numberOfLines={1}>
            {fmtDayHeader(currentKey, todayKey)}
          </Text>
        </View>
        <TouchableOpacity onPress={goNext} activeOpacity={0.6}
          disabled={currentIndex === dateKeys.length - 1}
          style={{ width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19, opacity: currentIndex === dateKeys.length - 1 ? 0.3 : 1 }}>
          <ChevronRight size={20} color="#3c4043" strokeWidth={2.2} />
        </TouchableOpacity>
      </View>

      <FlatList
        ref={flatListRef}
        data={dateKeys}
        keyExtractor={(k) => k}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={todayIndex}
        getItemLayout={(_, index) => ({ length: SCREEN_W, offset: SCREEN_W * index, index })}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
          if (idx !== currentIndex) setCurrentIndex(idx);
        }}
        renderItem={({ item }) => <DayPane dateKey={item} loads={loads} todayKey={todayKey} orgTz={orgTz} />}
      />
    </View>
  );
});
DayView.displayName = "DayView";
