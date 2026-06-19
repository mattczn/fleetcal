import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  Clock, Truck, ChevronRight, ChevronLeft, Calendar, List as ListIcon, Split, AlertTriangle, Inbox,
} from "lucide-react-native";
import { fetchLoadsForDriver } from "@/lib/api/loads";
import { useDriverSession } from "@/lib/useDriverSession";
import { useLoadsRealtime } from "@/lib/useLoadsRealtime";
import { useOrgTz, todayKeyInTz, nowInTz } from "@/lib/orgTz";
import { fmtTimeShort } from "@/lib/loadCard";
import type { Load, Stop } from "@/lib/types";
import { Glass } from "@/components/Glass";
import { EmptyState } from "@/components/EmptyState";
import { f, SP, RADIUS, type Colors } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

const { width: SCREEN_W } = Dimensions.get("window");
const DOW  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW1 = ["S", "M", "T", "W", "T", "F", "S"];
const MON  = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR_H = 58;
const GUTTER = 48;   // hour-label gutter
const EV_LEFT = 54;  // where event blocks start

/* ---- date helpers (operate on naive dispatch-zone YYYY-MM-DDTHH:mm) ---- */
function dayKey(iso?: string): string { return iso ? iso.slice(0, 10) : ""; }
function parseDay(key: string): Date { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); }
function keyOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function shiftKey(key: string, n: number): string { const d = parseDay(key); d.setDate(d.getDate() + n); return keyOf(d); }
function minutesOf(iso: string): number { const [h, m] = iso.slice(11, 16).split(":").map(Number); return (h || 0) * 60 + (m || 0); }
function spanDays(startIso: string, endIso: string): string[] {
  const a = parseDay(dayKey(startIso)), b = parseDay(dayKey(endIso || startIso));
  const out: string[] = []; const d = new Date(a);
  while (d <= b) { out.push(keyOf(d)); d.setDate(d.getDate() + 1); }
  return out.length ? out : [dayKey(startIso)];
}
function fmtHour(h: number): string { const ap = h < 12 ? "a" : "p"; return `${h % 12 || 12}${ap}`; }

type Kind = "full" | "pickup" | "delivery";
function kindOf(l: Load): Kind {
  return l.relayRole === "pickup" ? "pickup" : l.relayRole === "delivery" ? "delivery" : "full";
}
function cityOf(s?: Stop): string {
  if (!s) return "—";
  if (s.city && s.state) return `${s.city}, ${s.state}`;
  return s.city ?? s.facilityName ?? "—";
}
function kindChips(C: Colors): Record<Kind, { label: string | null; bg: string; fg: string }> {
  return {
    full:     { label: null,           bg: C.blueBg,  fg: C.blueInk },
    pickup:   { label: "PICKUP LEG",   bg: C.greenBg, fg: C.greenInk },
    delivery: { label: "DELIVERY LEG", bg: C.redBg,   fg: C.redInk },
  };
}
function kindBars(C: Colors, accent: string): Record<Kind, string> {
  return { full: accent, pickup: C.green, delivery: C.red };
}
// route dots: [origin, destination] colors per leg kind
function kindDots(C: Colors): Record<Kind, [string, string]> {
  return {
    full:     [C.green,  C.red],
    pickup:   [C.green,  C.purple],
    delivery: [C.purple, C.red],
  };
}

type Item = { load: Load; dayKeySel: string };

export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { C, SHADOW, ACCENT, ACCENT_INK, isDark } = useTheme();
  const router = useRouter();
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;
  useLoadsRealtime(driver?.driverId, driver?.orgId);
  const orgTz = useOrgTz(driver?.driverId, driver?.orgId);
  const todayKey = todayKeyInTz(orgTz);

  const { data: loads, isLoading, isError, refetch } = useQuery({
    queryKey: ["loads", driver?.driverId],
    queryFn:  () => fetchLoadsForDriver(driver!.driverId, driver!.orgId),
    enabled:  !!driver,
    staleTime: 30_000,
  });
  // Pull-to-refresh spinner only for user-initiated refreshes (background
  // refetches were leaving a stale spinner on tab navigation).
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try { await refetch(); } finally { setRefreshing(false); }
  };

  // Group loads by every calendar day they span (multi-day loads appear on each).
  const itemsByDay = useMemo(() => {
    const map: Record<string, Item[]> = {};
    for (const load of loads ?? []) {
      for (const dk of spanDays(load.start, load.end)) {
        (map[dk] = map[dk] || []).push({ load, dayKeySel: dk });
      }
    }
    for (const arr of Object.values(map)) {
      arr.sort((a, b) => a.load.start.slice(11).localeCompare(b.load.start.slice(11)));
    }
    return map;
  }, [loads]);

  const [selected, setSelected] = useState(todayKey);
  const [view, setView] = useState<"list" | "day">("list");

  // Snap to "today" once the org tz resolves (initial render may be "").
  useEffect(() => { setSelected((s) => (s ? s : todayKey)); }, [todayKey]);

  // Week window: Saturday → Friday containing `selected`.
  const days = useMemo(() => {
    const sel = parseDay(selected || todayKey);
    const back = (sel.getDay() + 1) % 7; // Sat→0 … Fri→6
    const start = new Date(sel); start.setDate(sel.getDate() - back);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return keyOf(d); });
  }, [selected, todayKey]);

  const items = itemsByDay[selected] ?? [];
  const loadCount = useMemo(() => new Set(items.map((i) => i.load.id)).size, [items]);
  const selDate = parseDay(selected || todayKey);
  const isToday = selected === todayKey;

  const wStart = parseDay(days[0]), wEnd = parseDay(days[6]);
  const rangeLabel = wStart.getMonth() === wEnd.getMonth()
    ? `${MON[wStart.getMonth()]} ${wStart.getDate()} – ${wEnd.getDate()}`
    : `${MON[wStart.getMonth()]} ${wStart.getDate()} – ${MON[wEnd.getMonth()]} ${wEnd.getDate()}`;

  function openLoad(id: string) {
    router.push({ pathname: "/load/[id]", params: { id } });
  }

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
            <Text style={[f(600), { fontSize: 13, color: C.t3, letterSpacing: 0.1 }]}>
              {MON[selDate.getMonth()]} {selDate.getFullYear()}
            </Text>
            <Text style={[f(800), { fontSize: 27, color: C.t1, marginTop: 1, letterSpacing: -0.6 }]}>Schedule</Text>
          </View>
          {!isToday ? (
            <TouchableOpacity
              onPress={() => setSelected(todayKey)}
              activeOpacity={0.8}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 13, borderRadius: 12, backgroundColor: C.surface, ...SHADOW.card }}
            >
              <Calendar size={14} color={ACCENT_INK} strokeWidth={2.2} />
              <Text style={[f(700), { fontSize: 12.5, color: ACCENT_INK }]}>Today</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Week nav + strip */}
        <View style={{ marginTop: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={[f(800), { fontSize: 13, color: C.t2, letterSpacing: -0.2 }]}>{rangeLabel}</Text>
            <View style={{ flexDirection: "row", gap: 4 }}>
              <TouchableOpacity onPress={() => setSelected(shiftKey(selected, -7))} activeOpacity={0.8}
                style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: C.surfaceSunk, alignItems: "center", justifyContent: "center" }}>
                <ChevronLeft size={18} color={C.t2} strokeWidth={2.4} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSelected(shiftKey(selected, 7))} activeOpacity={0.8}
                style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: C.surfaceSunk, alignItems: "center", justifyContent: "center" }}>
                <ChevronRight size={18} color={C.t2} strokeWidth={2.4} />
              </TouchableOpacity>
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {days.map((key) => {
              const d = parseDay(key);
              const isSel = key === selected, dayIsToday = key === todayKey, has = (itemsByDay[key]?.length ?? 0) > 0;
              return (
                <TouchableOpacity
                  key={key}
                  onPress={() => setSelected(key)}
                  activeOpacity={0.85}
                  style={[
                    { flex: 1, alignItems: "center", gap: 4, paddingVertical: 7, borderRadius: 14 },
                    isSel && { backgroundColor: C.surface, ...SHADOW.card },
                  ]}
                >
                  <Text style={[f(800), { fontSize: 11, letterSpacing: 0.2, color: dayIsToday && !isSel ? ACCENT_INK : isSel ? C.t1 : C.t3 }]}>
                    {DOW1[d.getDay()]}
                  </Text>
                  <View style={{ width: 30, height: 30, borderRadius: 999, alignItems: "center", justifyContent: "center", backgroundColor: isSel ? ACCENT : "transparent" }}>
                    <Text style={[f(800), { fontSize: 16, letterSpacing: -0.4, color: isSel ? "#fff" : dayIsToday ? ACCENT_INK : C.t1 }]}>
                      {d.getDate()}
                    </Text>
                  </View>
                  <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: ACCENT, opacity: has ? 1 : 0 }} />
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Glass>

      {/* Sub-header: day label + summary + view toggle */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: SP.screenPx, paddingTop: 13, paddingBottom: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <Text style={[f(800), { fontSize: 21, color: C.t1, letterSpacing: -0.5 }]}>
              {isToday ? "Today" : DOW[selDate.getDay()]}
            </Text>
            <Text style={[f(700), { fontSize: 14, color: C.t3 }]}>{MON[selDate.getMonth()]} {selDate.getDate()}</Text>
          </View>
          <Text style={[f(700), { fontSize: 12, color: C.t3, marginTop: 2 }]}>
            {items.length ? `${items.length} ${items.length === 1 ? "event" : "events"} · ${loadCount} ${loadCount === 1 ? "load" : "loads"}` : "No events"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 2, padding: 3, borderRadius: 11, backgroundColor: C.surfaceSunk }}>
          {([["list", ListIcon], ["day", Calendar]] as const).map(([v, Ico]) => {
            const on = view === v;
            return (
              <TouchableOpacity key={v} onPress={() => setView(v)} activeOpacity={0.8}
                style={[{ width: 36, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" }, on && { backgroundColor: C.surface, ...SHADOW.card }]}>
                <Ico size={16} color={on ? ACCENT_INK : C.t3} strokeWidth={2.3} />
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Body */}
      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : isError ? (
        <EmptyState title="Could not load schedule" subtitle="Pull down to retry" Icon={AlertTriangle} />
      ) : items.length === 0 ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
        >
          <View style={{ paddingTop: 50 }}>
            <EmptyState title="No events scheduled" subtitle="Pick another day with a dot, or change weeks with the arrows." Icon={Inbox} />
          </View>
        </ScrollView>
      ) : view === "list" ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: SP.screenPx, paddingTop: 8, paddingBottom: 130, gap: 12 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
        >
          {items.map((it) => <EventCard key={it.load.id + it.dayKeySel} item={it} onOpen={openLoad} />)}
        </ScrollView>
      ) : (
        <DayGrid items={items} onOpen={openLoad} showNow={isToday} nowMin={isToday ? nowInTz(orgTz).getHours() * 60 + nowInTz(orgTz).getMinutes() : 0} selectedKey={selected} />
      )}
    </View>
  );
}

/* ---------------- Agenda card ---------------- */
function EventCard({ item, onOpen }: { item: Item; onOpen: (id: string) => void }) {
  const { C, SHADOW, ACCENT } = useTheme();
  const { load, dayKeySel } = item;
  const kind = kindOf(load);
  const chip = kindChips(C)[kind];
  const [dotFrom, dotTo] = kindDots(C)[kind];
  const days = spanDays(load.start, load.end);
  const multi = days.length > 1;
  const idx = days.indexOf(dayKeySel);

  let timeText: string;
  if (!multi) timeText = `${fmtTimeShort(load.start)}–${fmtTimeShort(load.end)}`;
  else if (idx === 0) timeText = `${fmtTimeShort(load.start)} →`;
  else if (idx === days.length - 1) timeText = `→ ${fmtTimeShort(load.end)}`;
  else timeText = "All day";

  const from = load.stops[0];
  const to = load.stops[load.stops.length - 1];
  const miles = load.loadedMiles ?? load.miles;
  const isRelay = kind !== "full";

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => onOpen(load.id)}
      style={{ backgroundColor: C.surface, borderRadius: RADIUS.tile, borderWidth: 1, borderColor: C.border, ...SHADOW.card, padding: 14 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Clock size={12} color={C.t4} strokeWidth={2.3} />
          <Text style={[f(700), { fontSize: 12, color: C.t3 }]}>{timeText}</Text>
        </View>
        <View style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 7 }}>
          {chip.label ? (
            <View style={{ height: 20, paddingHorizontal: 8, borderRadius: 7, backgroundColor: chip.bg, justifyContent: "center" }}>
              <Text style={[f(800), { fontSize: 10, letterSpacing: 0.4, color: chip.fg }]}>{chip.label}</Text>
            </View>
          ) : null}
          {multi ? (
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: C.surfaceSunk }}>
              <Text style={[f(800), { fontSize: 10, letterSpacing: 0.3, color: C.t3 }]}>Day {idx + 1} of {days.length}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <Text style={[f(800), { fontSize: 16, color: C.t1, marginTop: 9, letterSpacing: -0.3, lineHeight: 20 }]} numberOfLines={2}>
        {load.title}
      </Text>

      {load.assetName || load.trailerType ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
          <Truck size={13} color={ACCENT} strokeWidth={2.2} />
          <Text style={[f(700), { fontSize: 12.5, color: C.t2 }]} numberOfLines={1}>
            {load.assetName ?? ""}{load.assetName && load.trailerType ? "  ·  " : ""}{load.trailerType ?? ""}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: dotFrom }} />
          <Text style={[f(700), { fontSize: 13, color: C.t2 }]}>{cityOf(from)}</Text>
        </View>
        <ChevronRight size={14} color={C.t4} strokeWidth={2.6} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: dotTo }} />
          <Text style={[f(700), { fontSize: 13, color: C.t2 }]}>{cityOf(to)}</Text>
        </View>
      </View>

      {isRelay && load.partnerDriverName ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 9, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, backgroundColor: C.purpleBg }}>
          <Split size={13} color={C.purpleInk} strokeWidth={2.2} />
          <Text style={[f(700), { fontSize: 12, color: C.purpleInk, flex: 1 }]}>
            {kind === "pickup" ? "Hand off to " : "Take over from "}
            <Text style={f(800)}>{load.partnerDriverName}</Text>
            {to ? ` at ${cityOf(to)}` : ""}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 11, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.borderSoft }}>
        {load.loadNum ? (
          <Text style={[f(700), { fontSize: 12, color: C.t2 }]} numberOfLines={1}>#{load.loadNum}</Text>
        ) : <View />}
        {miles != null ? <Text style={[f(800), { fontSize: 12, color: C.t3, marginLeft: "auto" }]}>{miles} mi</Text> : null}
        <ChevronRight size={15} color={C.t4} strokeWidth={2.4} style={{ marginLeft: miles != null ? 0 : "auto" }} />
      </View>
    </TouchableOpacity>
  );
}

/* ---------------- Day grid (24h) ---------------- */
type Block = Item & { startMin: number; endMin: number; contPrev: boolean; contNext: boolean; col: number; cols: number };

function layoutColumns(blocks: Block[]) {
  let cluster: Block[] = [], colEnds: number[] = [], clusterEnd = -1;
  const flush = () => {
    const n = Math.max(...cluster.map((b) => b.col)) + 1;
    cluster.forEach((b) => (b.cols = n));
    cluster = []; colEnds = [];
  };
  for (const b of blocks) {
    if (cluster.length && b.startMin >= clusterEnd) flush();
    let placed = false;
    for (let i = 0; i < colEnds.length; i++) {
      if (colEnds[i] <= b.startMin) { b.col = i; colEnds[i] = b.endMin; placed = true; break; }
    }
    if (!placed) { b.col = colEnds.length; colEnds.push(b.endMin); }
    cluster.push(b);
    clusterEnd = cluster.length === 1 ? b.endMin : Math.max(clusterEnd, b.endMin);
  }
  if (cluster.length) flush();
}

function DayGrid({ items, onOpen, showNow, nowMin, selectedKey }: {
  items: Item[]; onOpen: (id: string) => void; showNow: boolean; nowMin: number; selectedKey: string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const { C, SHADOW, ACCENT } = useTheme();
  const chips = kindChips(C);
  const bars = kindBars(C, ACCENT);
  const evWidth = SCREEN_W - EV_LEFT - SP.screenPx;

  const blocks = useMemo(() => {
    const bs: Block[] = items.map((it) => {
      const days = spanDays(it.load.start, it.load.end);
      const idx = days.indexOf(it.dayKeySel);
      const startMin = idx === 0 ? minutesOf(it.load.start) : 0;
      const endRaw = idx === days.length - 1 ? minutesOf(it.load.end) : 24 * 60;
      return { ...it, startMin, endMin: Math.max(endRaw, startMin + 45), contPrev: idx > 0, contNext: idx < days.length - 1, col: 0, cols: 1 };
    }).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    layoutColumns(bs);
    return bs;
  }, [items]);

  useEffect(() => {
    const first = blocks.length ? blocks[0].startMin : 8 * 60;
    scrollRef.current?.scrollTo({ y: Math.max(0, (first / 60) * HOUR_H - 46), animated: false });
  }, [blocks, selectedKey]);

  return (
    <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingLeft: SP.screenPx, paddingRight: 0, paddingTop: 6, paddingBottom: 130 }} showsVerticalScrollIndicator={false}>
      <View style={{ height: 24 * HOUR_H, position: "relative" }}>
        {Array.from({ length: 24 }, (_, h) => (
          <View key={h} style={{ position: "absolute", top: h * HOUR_H, left: GUTTER, right: 0, borderTopWidth: 1, borderTopColor: C.borderStrong }}>
            <Text style={[f(700), { position: "absolute", left: -44, top: -7, width: 38, textAlign: "right", fontSize: 10.5, color: C.t3 }]}>
              {h === 0 ? "" : fmtHour(h)}
            </Text>
          </View>
        ))}

        {showNow ? (
          <View style={{ position: "absolute", top: (nowMin / 60) * HOUR_H, left: GUTTER, right: 0, borderTopWidth: 2, borderTopColor: C.red, zIndex: 6 }}>
            <View style={{ position: "absolute", left: -5, top: -5, width: 9, height: 9, borderRadius: 999, backgroundColor: C.red }} />
          </View>
        ) : null}

        {blocks.map((b) => {
          const kind = kindOf(b.load);
          const top = (b.startMin / 60) * HOUR_H;
          const height = ((b.endMin - b.startMin) / 60) * HOUR_H;
          const compact = height < 78;
          const colW = evWidth / b.cols;
          const left = EV_LEFT + b.col * colW;
          const chip = chips[kind];
          const miles = b.load.loadedMiles ?? b.load.miles;
          return (
            <TouchableOpacity
              key={b.load.id + b.dayKeySel}
              activeOpacity={0.92}
              onPress={() => onOpen(b.load.id)}
              style={{
                position: "absolute", top: top + 2, height: height - 4, left: left + 2, width: colW - 6,
                borderRadius: 12, overflow: "hidden", flexDirection: "row",
                backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, ...SHADOW.card,
              }}
            >
              <View style={{ width: 4, backgroundColor: bars[kind] }} />
              <View style={{ flex: 1, minWidth: 0, paddingHorizontal: 9, paddingVertical: compact ? 5 : 7 }}>
                <Text style={[f(800), { fontSize: 13.5, color: C.t1, letterSpacing: -0.2, lineHeight: 17 }]} numberOfLines={compact ? 1 : 2}>
                  {b.load.title}
                </Text>
                {b.load.assetName ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: compact ? 2 : 4 }}>
                    <Truck size={12} color={ACCENT} strokeWidth={2.2} />
                    <Text style={[f(800), { fontSize: 11, color: C.t1 }]} numberOfLines={1}>{b.load.assetName}</Text>
                  </View>
                ) : null}
                {!compact && height > 150 ? (
                  <Text style={[f(700), { fontSize: 11, color: C.t4, marginTop: 5 }]} numberOfLines={1}>
                    {b.load.loadNum ? `#${b.load.loadNum}` : ""}{b.load.loadNum && miles != null ? " · " : ""}{miles != null ? `${miles} mi` : ""}
                  </Text>
                ) : null}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
                  {chip.label ? (
                    <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: chip.bg }}>
                      <Text style={[f(800), { fontSize: 9, letterSpacing: 0.3, color: chip.fg }]}>{chip.label}</Text>
                    </View>
                  ) : null}
                  <Text style={[f(800), { fontSize: 10.5, color: C.t3 }]}>
                    {b.contPrev ? "12a" : fmtTimeShort(b.load.start)}–{b.contNext ? "12a" : fmtTimeShort(b.load.end)}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}
