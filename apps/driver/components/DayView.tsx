import React, { useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, FlatList, Dimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import type { Load } from "@/lib/types";
import { needsConfirmation } from "@/lib/loadStatus";

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
function todayKey(): string { return dateKeyFromDate(new Date()); }

function fmtDayHeader(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const dateLabel = d.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    year: today.getFullYear() !== d.getFullYear() ? "numeric" : undefined,
  });
  if (same(d, today)) return `Today · ${dateLabel}`;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (same(d, tomorrow)) return `Tomorrow · ${dateLabel}`;
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  if (same(d, yest)) return `Yesterday · ${dateLabel}`;
  return dateLabel;
}

function fmtHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function fmtTime(iso: string): string {
  if (!iso) return "";
  const t = iso.slice(11, 16);
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 || 12;
  return m === 0 ? `${hh} ${ampm}` : `${hh}:${pad(m)} ${ampm}`;
}

interface PositionedEvent {
  load: Load; top: number; height: number;
  spansBefore: boolean; spansAfter: boolean;
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
  };
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

function NowLine({ dateKey }: { dateKey: string }) {
  const [, force] = useState(0);
  React.useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  if (dateKey !== todayKey()) return null;
  const now = new Date();
  const top = (now.getHours() + now.getMinutes() / 60) * HOUR_HEIGHT;
  return (
    <View style={{ position: "absolute", top, left: HOUR_LABEL_WIDTH - 4, right: 8, zIndex: 10, flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#ea4335", marginLeft: -4 }} />
      <View style={{ flex: 1, height: 2, backgroundColor: "#ea4335" }} />
    </View>
  );
}

function EventBlock({ ev }: { ev: PositionedEvent }) {
  const router = useRouter();
  const { load, top, height, spansBefore, spansAfter } = ev;
  const startLabel = spansBefore ? "Continues" : fmtTime(load.start);
  const endLabel   = spansAfter  ? "Continues" : fmtTime(load.end);
  const needsAction = needsConfirmation(load);
  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: load.id } })}
      activeOpacity={0.85}
      style={{
        position: "absolute", top, height,
        left: HOUR_LABEL_WIDTH + 6, right: 8,
        backgroundColor: needsAction ? "#fee2e2" : "#e8f0fe",
        borderLeftWidth: 4, borderLeftColor: needsAction ? "#dc2626" : "#1a73e8",
        borderRadius: 8, padding: 6, overflow: "hidden",
      }}
    >
      <Text style={[txt(800), { fontSize: 11, color: needsAction ? "#dc2626" : "#1a73e8", letterSpacing: 0.2 }]} numberOfLines={1}>
        {startLabel}{startLabel !== endLabel ? ` – ${endLabel}` : ""}
      </Text>
      <Text style={[txt(800), { fontSize: 13, color: "#1a3060", marginTop: 1 }]} numberOfLines={2}>
        {load.title}
      </Text>
      {height >= 64 ? (
        <Text style={[txt(600), { fontSize: 11, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
          {load.assetName ?? ""}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function DayPane({ dateKey, loads }: { dateKey: string; loads: Load[] }) {
  const events = useMemo(
    () => loads.map((l) => positionFor(l, dateKey)).filter((p): p is PositionedEvent => p !== null),
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
      <NowLine dateKey={dateKey} />
      {events.map((ev) => <EventBlock key={ev.load.id} ev={ev} />)}
    </ScrollView>
  );
}

export interface DayViewHandle { goToToday: () => void; }

export const DayView = React.forwardRef<DayViewHandle, { loads: Load[] }>(({ loads }, ref) => {
  const dateKeys = useMemo(() => {
    const out: string[] = [];
    const center = new Date();
    for (let i = -DAY_RANGE; i <= DAY_RANGE; i++) {
      const d = new Date(center);
      d.setDate(center.getDate() + i);
      out.push(dateKeyFromDate(d));
    }
    return out;
  }, []);
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
            {fmtDayHeader(currentKey)}
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
        renderItem={({ item }) => <DayPane dateKey={item} loads={loads} />}
      />
    </View>
  );
});
DayView.displayName = "DayView";
