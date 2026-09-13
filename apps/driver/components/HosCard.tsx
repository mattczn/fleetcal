/**
 * HosCard — the clock in / clock out card at the top of the Active tab.
 *
 * Three states, in order of how often a driver sees them:
 *
 *   OFF DUTY  Clock In, plus last shift's hours. If they're inside the
 *             10-hour rest the button goes amber and shows when they're
 *             clear — a warning, never a block. There are legitimate
 *             reasons to start early, and a hard block just means the
 *             driver doesn't clock in at all and we lose the day.
 *
 *   ON DUTY   Live shift timer as the hero, with the 14-hour window as
 *             a progress bar. The visible running clock is the point:
 *             it's the cheapest defense we have against forgotten
 *             clock-outs, because a driver who sees "13h 40m" fixes it
 *             themselves.
 *
 *   STALE     Past 14 hours. The timer stops being a timer and becomes
 *             "when did you actually finish?" with quick picks. The
 *             driver is the only person who knows the real answer, so
 *             this belongs on their phone rather than in a dispatch
 *             cleanup queue.
 *
 * The 70/8 cycle total is deliberately absent. It's only as good as a
 * week of clean clock-ins across the whole fleet; today's timer is only
 * as good as today. Fragile numbers stay where dispatch can check them.
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { Play, Square, Clock, AlertTriangle, Moon, FileText } from "lucide-react-native";
import { useTheme } from "@/lib/ThemeProvider";
import type { HosStatusResponse } from "@/lib/railway";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium" :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold" :
                     "PlusJakartaSans_800ExtraBold",
});

const SHIFT_WINDOW_SECONDS = 14 * 3600;

/** Minute resolution is all a shift timer needs, so re-render every 20s
 *  rather than every second — same perceived liveness, a fraction of
 *  the wakeups. */
const TICK_MS = 20_000;

function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtDayAndClock(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400_000).toDateString() === d.toDateString();
  const day = sameDay ? "" : yesterday ? "yesterday " : `${d.toLocaleDateString([], { weekday: "short" })} `;
  return `${day}${fmtClock(iso)}`;
}

interface Props {
  data:    HosStatusResponse | null;
  loading: boolean;
  busy:    boolean;
  onClockIn:  () => void;
  onClockOut: () => void;
  /** Driver answering the stale prompt. `endedAt` is an absolute ISO
   *  timestamp derived from a quick-pick offset off the shift start. */
  onCorrectEnd: (shiftId: string, endedAt: string) => void;
  /** Dismisses the stale prompt for this session when the driver really
   *  has been on duty this long. */
  onKeepRunning: () => void;
  staleDismissed: boolean;
}

export default function HosCard({
  data, loading, busy, onClockIn, onClockOut, onCorrectEnd, onKeepRunning, staleDismissed,
}: Props) {
  const { C } = useTheme();

  // Tick only while a shift is running — an off-duty card has nothing
  // that changes second to second.
  const onDuty = data?.status === "on_duty";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!onDuty) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [onDuty]);

  const shift = data?.currentShift ?? null;

  // Recompute locally off the wall clock rather than trusting the
  // server's elapsedSeconds, which is only accurate at fetch time.
  const elapsed = useMemo(() => {
    if (!shift) return 0;
    return Math.max(0, (now - new Date(shift.startedAt).getTime()) / 1000);
  }, [shift, now]);
  const remaining = Math.max(0, SHIFT_WINDOW_SECONDS - elapsed);
  const expired = elapsed >= SHIFT_WINDOW_SECONDS;

  if (loading && !data) {
    return (
      <View style={[cardBase, { borderColor: C.border, backgroundColor: C.surface }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={C.t3} />
          <Text style={[txt(500), { color: C.t3, fontSize: 13 }]}>Checking your hours…</Text>
        </View>
      </View>
    );
  }

  // HOS switched off for this driver — render nothing at all rather
  // than an empty shell.
  if (!data?.enabled) return null;

  if (onDuty && shift) {
    if (expired && !staleDismissed) {
      return (
        <StalePrompt
          shiftId={shift.id}
          startedAt={shift.startedAt}
          elapsed={elapsed}
          busy={busy}
          onCorrectEnd={onCorrectEnd}
          onKeepRunning={onKeepRunning}
        />
      );
    }
    return (
      <OnDutyCard
        shift={shift}
        elapsed={elapsed}
        remaining={remaining}
        busy={busy}
        onClockOut={onClockOut}
      />
    );
  }

  return <OffDutyCard data={data} busy={busy} onClockIn={onClockIn} />;
}

// ── Off duty ─────────────────────────────────────────────────────────

function OffDutyCard({ data, busy, onClockIn }: {
  data: HosStatusResponse; busy: boolean; onClockIn: () => void;
}) {
  const { C } = useTheme();
  const rest = data.rest ?? null;
  const last = data.lastShift ?? null;
  // Inside the 10-hour reset: warn, don't block.
  const resting = rest != null && !rest.satisfied;

  const accent   = resting ? C.amber   : C.green;
  const accentBg = resting ? C.amberBg : C.greenBg;
  const ink      = resting ? C.amberInk : C.greenInk;

  return (
    <View style={[cardBase, { backgroundColor: C.surface, borderColor: C.border }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <View style={{
          width: 34, height: 34, borderRadius: 17, backgroundColor: accentBg,
          alignItems: "center", justifyContent: "center",
        }}>
          <Moon size={17} color={ink} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[txt(800), { fontSize: 15, color: C.t1 }]}>Off duty</Text>
          {last?.endedAt ? (
            <Text style={[txt(500), { fontSize: 12.5, color: C.t3, marginTop: 1 }]}>
              Last shift {fmtDayAndClock(last.startedAt)} – {fmtClock(last.endedAt)}
              {last.onDutySeconds != null ? ` · ${fmtDuration(last.onDutySeconds)}` : ""}
            </Text>
          ) : (
            <Text style={[txt(500), { fontSize: 12.5, color: C.t3, marginTop: 1 }]}>
              No shift recorded yet
            </Text>
          )}
        </View>
      </View>

      {resting && rest && (
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 8,
          backgroundColor: C.amberBg, borderRadius: 10, padding: 10, marginBottom: 12,
        }}>
          <Clock size={14} color={C.amberInk} />
          <Text style={[txt(600), { fontSize: 12.5, color: C.amberInk, flex: 1 }]}>
            {fmtDuration(rest.restSeconds)} off so far — you&apos;re clear at {fmtClock(rest.clearAt)}
          </Text>
        </View>
      )}

      <TouchableOpacity
        onPress={onClockIn}
        disabled={busy}
        activeOpacity={0.85}
        style={{
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          backgroundColor: busy ? C.t4 : accent,
          paddingVertical: 15, borderRadius: 12,
        }}
      >
        {busy
          ? <ActivityIndicator size="small" color="white" />
          : <Play size={17} color="white" fill="white" />}
        <Text style={[txt(800), { fontSize: 16, color: "white" }]}>
          {busy ? "Starting…" : "Clock In"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ── On duty ──────────────────────────────────────────────────────────

function OnDutyCard({ shift, elapsed, remaining, busy, onClockOut }: {
  shift: NonNullable<HosStatusResponse["currentShift"]>;
  elapsed: number; remaining: number; busy: boolean; onClockOut: () => void;
}) {
  const { C } = useTheme();
  const pct = Math.min(1, elapsed / SHIFT_WINDOW_SECONDS);
  // Escalate as the window closes. 10h and 13h are judgement calls, not
  // regulatory thresholds — they exist to give a driver warning before
  // the number turns into a problem.
  const barColor = elapsed >= 13 * 3600 ? C.red : elapsed >= 10 * 3600 ? C.amber : C.green;
  const isOtr = shift.classification === "otr";

  return (
    <View style={[cardBase, { backgroundColor: C.surface, borderColor: C.border, padding: 0, overflow: "hidden" }]}>
      {/* OTR strip — phrased as an instruction, because the label "OTR"
          on its own tells a driver nothing they can act on. */}
      {isOtr && (
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 8,
          backgroundColor: C.blueBg, paddingHorizontal: 14, paddingVertical: 9,
        }}>
          <FileText size={14} color={C.blueInk} />
          <Text style={[txt(700), { fontSize: 12.5, color: C.blueInk, flex: 1 }]}>
            OTR run today — make sure your log is going
          </Text>
        </View>
      )}

      <View style={{ padding: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{
            width: 10, height: 10, borderRadius: 5, backgroundColor: C.green,
          }} />
          <Text style={[txt(700), { fontSize: 12, color: C.greenInk, letterSpacing: 0.5 }]}>
            ON DUTY
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={[txt(500), { fontSize: 12.5, color: C.t3 }]}>
            since {fmtDayAndClock(shift.startedAt)}
          </Text>
        </View>

        <Text style={[txt(800), { fontSize: 40, color: C.t1, marginTop: 8, letterSpacing: -1 }]}>
          {fmtDuration(elapsed)}
        </Text>

        <View style={{ marginTop: 12, marginBottom: 4 }}>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: C.surfaceSunk, overflow: "hidden" }}>
            <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: barColor }} />
          </View>
          <Text style={[txt(600), { fontSize: 12, color: C.t2, marginTop: 7 }]}>
            {remaining > 0
              ? `${fmtDuration(remaining)} left in your 14`
              : "14-hour window is up"}
          </Text>
        </View>

        <TouchableOpacity
          onPress={onClockOut}
          disabled={busy}
          activeOpacity={0.85}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            backgroundColor: busy ? C.t4 : C.surface2,
            borderWidth: 1, borderColor: busy ? C.t4 : C.borderStrong,
            paddingVertical: 14, borderRadius: 12, marginTop: 14,
          }}
        >
          {busy
            ? <ActivityIndicator size="small" color={C.t2} />
            : <Square size={15} color={C.t1} fill={C.t1} />}
          <Text style={[txt(800), { fontSize: 15, color: busy ? "white" : C.t1 }]}>
            {busy ? "Saving…" : "Clock Out"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Stale (missed clock-out) ─────────────────────────────────────────

function StalePrompt({ shiftId, startedAt, elapsed, busy, onCorrectEnd, onKeepRunning }: {
  shiftId: string; startedAt: string; elapsed: number; busy: boolean;
  onCorrectEnd: (shiftId: string, endedAt: string) => void;
  onKeepRunning: () => void;
}) {
  const { C } = useTheme();
  const startMs = new Date(startedAt).getTime();

  // Offsets from the shift start rather than absolute times: the driver
  // remembers "I worked about ten hours", not "I clocked out at 4:14".
  // Anything landing in the future is dropped, which matters when the
  // shift started only a few hours before midnight.
  const picks = useMemo(
    () => [8, 10, 12, 14]
      .map(h => ({ hours: h, at: new Date(startMs + h * 3600_000) }))
      .filter(p => p.at.getTime() <= Date.now()),
    [startMs],
  );

  return (
    <View style={[cardBase, { backgroundColor: C.amberBg, borderColor: C.amber }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <AlertTriangle size={16} color={C.amberInk} />
        <Text style={[txt(800), { fontSize: 15, color: C.amberInk }]}>Still clocked in</Text>
      </View>
      <Text style={[txt(600), { fontSize: 13, color: C.amberInk, marginBottom: 14, lineHeight: 19 }]}>
        You&apos;ve been on duty {fmtDuration(elapsed)}, since {fmtDayAndClock(startedAt)}.
        When did you actually finish?
      </Text>

      <View style={{ gap: 8 }}>
        {picks.map(p => (
          <TouchableOpacity
            key={p.hours}
            disabled={busy}
            onPress={() => onCorrectEnd(shiftId, p.at.toISOString())}
            activeOpacity={0.85}
            style={{
              flexDirection: "row", alignItems: "center", justifyContent: "space-between",
              backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
              paddingVertical: 13, paddingHorizontal: 14, borderRadius: 11,
            }}
          >
            <Text style={[txt(700), { fontSize: 14.5, color: C.t1 }]}>
              After {p.hours} hours
            </Text>
            <Text style={[txt(600), { fontSize: 13, color: C.t3 }]}>
              {fmtDayAndClock(p.at.toISOString())}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        onPress={onKeepRunning}
        disabled={busy}
        style={{ paddingVertical: 12, alignItems: "center", marginTop: 4 }}
      >
        <Text style={[txt(700), { fontSize: 13.5, color: C.amberInk }]}>
          I&apos;m still on duty
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const cardBase = {
  marginHorizontal: 14,
  marginTop:        6,
  marginBottom:     10,
  borderRadius:     12,
  borderWidth:      1,
  padding:          16,
};
