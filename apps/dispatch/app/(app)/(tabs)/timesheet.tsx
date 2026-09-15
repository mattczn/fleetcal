/**
 * /timesheet — clock in, clock out, and read back hours.
 *
 * One screen for two audiences, decided by capability rather than by
 * role:
 *   · timesheet.self      punch the clock + see your own history
 *   · timesheet.view_all  additionally see everyone else's
 *
 * The server narrows the list on its own for a caller without
 * view_all (GET /v1/timesheets returns `scope: "self"`), so the toggle
 * below is an affordance, not the enforcement.
 *
 * ── What this screen owes the person using it ─────────────────────────
 *
 * It is recording where they are. That earns some honesty in the UI:
 *   · the running clock says plainly that location is being recorded,
 *     and only while clocked in
 *   · if background tracking has stopped (the "Always" → "While Using"
 *     downgrade iOS never tells the app about), that is shown as a
 *     warning rather than left to look like a normal quiet afternoon
 *   · buffered samples waiting on signal are surfaced as a count, so a
 *     shop with no bars looks like "holding 6" instead of silence
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Alert, Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrganization, useUser } from "@clerk/clerk-expo";
import {
  Play, Square, MapPin, MapPinOff, Clock, Users, User as UserIcon, CloudUpload,
} from "lucide-react-native";
import type { TimesheetShift } from "@fleetcal/types";
import { txt } from "@/lib/font";
import { railway } from "@/lib/railway";
import { usePermissions } from "@/lib/usePermissions";
import {
  startShiftTracking, stopShiftTracking, flushPings,
  verifyTrackingAlive, getTrackingHealth, bufferedPingCount,
} from "@/lib/shiftTracking";

// ── Helpers ───────────────────────────────────────────────────────────

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "6h 12m" — the one duration format used everywhere on this screen. */
function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function elapsedMinutes(startedAt: string, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - new Date(startedAt).getTime()) / 60000));
}

// ── Screen ────────────────────────────────────────────────────────────

export default function TimesheetScreen() {
  const insets = useSafeAreaInsets();
  const { organization } = useOrganization();
  const { user } = useUser();
  const orgId = organization?.id;
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canViewAll = can("timesheet.view_all");

  const [scope, setScope] = useState<"self" | "org">("self");
  const [busy, setBusy] = useState(false);
  // Ticks once a minute so the running clock advances without a refetch.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [trackingStoppedAt, setTrackingStoppedAt] = useState<string | null>(null);
  const [buffered, setBuffered] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const activeQ = useQuery({
    queryKey: ["timesheet", "active", orgId],
    queryFn:  async () => (await railway.getActiveTimesheetShift()).shift,
    enabled:  !!orgId,
  });

  const listQ = useQuery({
    queryKey: ["timesheet", "shifts", orgId, scope],
    queryFn:  async () =>
      (await railway.listTimesheetShifts(
        scope === "org" && canViewAll ? { all: true, limit: 200 } : { limit: 100 },
      )).shifts,
    enabled: !!orgId,
  });

  const active = activeQ.data ?? null;

  // Whenever this screen is looked at: re-check that background updates
  // are actually still being delivered, refresh the buffered count, and
  // spend any signal we have. This is the ONLY place a permission
  // downgrade gets noticed — iOS just stops calling the task.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (active?.id) {
          await verifyTrackingAlive();
          await flushPings(active.id);
        }
        const [health, count] = await Promise.all([getTrackingHealth(), bufferedPingCount()]);
        if (cancelled) return;
        setTrackingStoppedAt(health.stoppedAt ?? null);
        setBuffered(count);
      })();
      return () => { cancelled = true; };
    }, [active?.id]),
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["timesheet"] });
  };

  async function handleClockIn() {
    if (busy) return;
    setBusy(true);
    try {
      // Clock in FIRST, then start tracking. If this order were
      // reversed, a denied permission prompt would leave the person
      // un-clocked-in — the hour matters more than the trail.
      const { shift } = await railway.clockIn({});
      await qc.invalidateQueries({ queryKey: ["timesheet"] });

      const res = await startShiftTracking(shift.id);
      if (!res.ok) {
        // Not an error state for the shift — it is running either way.
        Alert.alert(
          "Clocked in — location is off",
          res.reason === "background_denied"
            ? "Your hours are being recorded, but location needs \"Always Allow\" to update while the app is closed. You can change it in Settings."
            : "Your hours are being recorded, but this phone isn't sharing location.",
          res.reason === "background_denied"
            ? [{ text: "Not now" }, { text: "Open Settings", onPress: () => void Linking.openSettings() }]
            : [{ text: "OK" }],
        );
      }
      const health = await getTrackingHealth();
      setTrackingStoppedAt(health.stoppedAt ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      // The server refuses a second open shift (409). That almost always
      // means a retry landed twice — resync rather than alarm.
      if (msg.includes("already_clocked_in")) {
        await qc.invalidateQueries({ queryKey: ["timesheet"] });
      } else {
        Alert.alert("Couldn't clock in", msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleClockOut() {
    if (busy || !active) return;
    setBusy(true);
    try {
      // Last flush BEFORE closing the shift so the final samples land
      // against a shift that is still open.
      await flushPings(active.id);
      const health = await getTrackingHealth();
      await railway.clockOut(active.id, {
        trackingStoppedAt: health.stoppedAt,
      });
      await stopShiftTracking();
      setTrackingStoppedAt(null);
      setBuffered(await bufferedPingCount());
      await qc.invalidateQueries({ queryKey: ["timesheet"] });
    } catch (err) {
      Alert.alert("Couldn't clock out", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  function confirmClockOut() {
    if (!active) return;
    const mins = elapsedMinutes(active.startedAt, Date.now());
    Alert.alert(
      "Clock out?",
      `You've been on the clock ${fmtDuration(mins)}.`,
      [{ text: "Cancel", style: "cancel" }, { text: "Clock out", onPress: () => void handleClockOut() }],
    );
  }

  if (!orgId) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: insets.top + 24 }}>
        <Text style={[txt(700), { color: "#5f6368" }]}>No organization selected.</Text>
      </View>
    );
  }

  const shifts = listQ.data ?? [];
  const loading = activeQ.isLoading || listQ.isLoading;

  return (
    <View style={{ flex: 1, backgroundColor: "#f8f9fa" }}>
      {/* Header */}
      <View style={{ backgroundColor: "#1a73e8", paddingHorizontal: 16, paddingTop: insets.top + 8, paddingBottom: 12 }}>
        <Text style={[txt(800), { fontSize: 22, color: "#ffffff", letterSpacing: -0.3 }]}>
          Timesheet
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={listQ.isFetching} onRefresh={refresh} tintColor="#1a73e8" />}
      >
        {/* Clock card */}
        <View style={{
          margin: 14, padding: 18, borderRadius: 14,
          backgroundColor: "#ffffff",
          borderWidth: 1, borderColor: active ? "#bfdbfe" : "#eef0f2",
        }}>
          {active ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Clock size={16} color="#1a73e8" strokeWidth={2.4} />
                <Text style={[txt(800), { fontSize: 13, color: "#1a73e8", letterSpacing: 0.4 }]}>
                  ON THE CLOCK
                </Text>
              </View>
              <Text style={[txt(800), { fontSize: 38, color: "#202124", marginTop: 8, letterSpacing: -1 }]}>
                {fmtDuration(elapsedMinutes(active.startedAt, nowMs))}
              </Text>
              <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginTop: 2 }]}>
                Since {fmtClock(active.startedAt)}
              </Text>
            </>
          ) : (
            <>
              <Text style={[txt(800), { fontSize: 15, color: "#202124" }]}>Not clocked in</Text>
              <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 4 }]}>
                Your location is recorded only between clock in and clock out.
              </Text>
            </>
          )}

          <TouchableOpacity
            onPress={active ? confirmClockOut : handleClockIn}
            disabled={busy || activeQ.isLoading}
            activeOpacity={0.85}
            style={{
              marginTop: 16, paddingVertical: 15, borderRadius: 12,
              flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
              backgroundColor: busy ? "#9aa0a6" : active ? "#ea4335" : "#1a73e8",
            }}
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                {active
                  ? <Square size={16} color="#ffffff" strokeWidth={2.6} />
                  : <Play size={16} color="#ffffff" strokeWidth={2.6} />}
                <Text style={[txt(800), { fontSize: 15, color: "#ffffff", letterSpacing: 0.3 }]}>
                  {active ? "CLOCK OUT" : "CLOCK IN"}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {/* Location status — only meaningful while a shift is running. */}
          {active ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 }}>
              {trackingStoppedAt ? (
                <>
                  <MapPinOff size={13} color="#c5221f" strokeWidth={2.4} />
                  <Text style={[txt(600), { fontSize: 11, color: "#c5221f", flex: 1 }]}>
                    Location stopped at {fmtClock(trackingStoppedAt)} — needs "Always Allow"
                  </Text>
                  <TouchableOpacity onPress={() => void Linking.openSettings()} hitSlop={8}>
                    <Text style={[txt(800), { fontSize: 11, color: "#1a73e8" }]}>FIX</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <MapPin size={13} color="#1e8e3e" strokeWidth={2.4} />
                  <Text style={[txt(600), { fontSize: 11, color: "#1e8e3e", flex: 1 }]}>
                    Location recording about every 10 minutes
                  </Text>
                </>
              )}
            </View>
          ) : null}

          {buffered > 0 ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
              <CloudUpload size={13} color="#b06000" strokeWidth={2.4} />
              <Text style={[txt(600), { fontSize: 11, color: "#b06000" }]}>
                {buffered} location{buffered === 1 ? "" : "s"} waiting to upload
              </Text>
            </View>
          ) : null}
        </View>

        {/* Scope toggle — reviewers only */}
        {canViewAll ? (
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, marginBottom: 6 }}>
            <ScopeTab
              label="Mine" Icon={UserIcon}
              active={scope === "self"} onPress={() => setScope("self")}
            />
            <ScopeTab
              label="Everyone" Icon={Users}
              active={scope === "org"} onPress={() => setScope("org")}
            />
          </View>
        ) : null}

        <Text style={[txt(800), {
          fontSize: 11, color: "#5f6368", letterSpacing: 0.6,
          paddingHorizontal: 14, paddingVertical: 8,
        }]}>
          RECENT SHIFTS · {shifts.length}
        </Text>

        {loading && shifts.length === 0 ? (
          <View style={{ paddingVertical: 32, alignItems: "center" }}>
            <ActivityIndicator color="#1a73e8" />
          </View>
        ) : shifts.length === 0 ? (
          <Text style={[txt(500), {
            fontSize: 12, color: "#9aa0a6",
            paddingHorizontal: 16, paddingVertical: 12, textAlign: "center",
          }]}>
            No shifts recorded yet.
          </Text>
        ) : (
          shifts.map((s) => (
            <ShiftRow
              key={s.id}
              shift={s}
              showName={scope === "org"}
              isMe={s.userId === user?.id}
              nowMs={nowMs}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function ScopeTab({
  label, Icon, active, onPress,
}: {
  label: string;
  Icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        flexDirection: "row", alignItems: "center", gap: 6,
        paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
        backgroundColor: active ? "#e8f0fe" : "#ffffff",
        borderWidth: 1, borderColor: active ? "#bfdbfe" : "#eef0f2",
      }}
    >
      <Icon size={13} color={active ? "#1967d2" : "#5f6368"} strokeWidth={2.4} />
      <Text style={[txt(800), { fontSize: 12, color: active ? "#1967d2" : "#5f6368" }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function ShiftRow({
  shift, showName, isMe, nowMs,
}: {
  shift: TimesheetShift;
  showName: boolean;
  isMe: boolean;
  nowMs: number;
}) {
  const running = !shift.endedAt;
  // durationMinutes is null while open — compute the live value rather
  // than rendering a blank for the shift someone is standing in.
  const minutes = shift.durationMinutes ?? elapsedMinutes(shift.startedAt, nowMs);

  return (
    <View style={{
      backgroundColor: "#ffffff",
      marginHorizontal: 14, marginBottom: 8,
      padding: 12, borderRadius: 10,
      borderWidth: 1, borderColor: running ? "#bfdbfe" : "#eef0f2",
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[txt(800), { fontSize: 13, color: "#202124", flex: 1 }]} numberOfLines={1}>
          {showName ? (shift.userName ?? (isMe ? "You" : "Unknown")) : fmtDay(shift.startedAt)}
        </Text>
        <Text style={[txt(800), { fontSize: 13, color: running ? "#1a73e8" : "#202124" }]}>
          {fmtDuration(minutes)}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
        <Text style={[txt(600), { fontSize: 11, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
          {showName ? `${fmtDay(shift.startedAt)} · ` : ""}
          {fmtClock(shift.startedAt)} – {shift.endedAt ? fmtClock(shift.endedAt) : "running"}
        </Text>
        {/* A shift whose tracking died is flagged here so a sparse map
            isn't mistaken for someone who never moved. */}
        {shift.trackingStoppedAt ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <MapPinOff size={11} color="#b06000" strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 10, color: "#b06000" }]}>PARTIAL</Text>
          </View>
        ) : null}
        {shift.editedBy ? (
          <Text style={[txt(700), { fontSize: 10, color: "#9aa0a6" }]}>EDITED</Text>
        ) : null}
      </View>
    </View>
  );
}
