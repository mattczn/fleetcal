/**
 * HosCard — the clock in / clock out card at the top of the Active tab.
 *
 * Three states, in order of how often a driver sees them:
 *
 *   OFF DUTY  Clock In, plus last shift's hours with an edit affordance.
 *             Inside the 10-hour rest the button goes amber — a warning,
 *             never a block. There are legitimate reasons to start early,
 *             and a hard block just means the driver doesn't clock in at
 *             all and we lose the day. See DutyOptionsBox for why this
 *             state shows two options rather than one.
 *
 *   ON DUTY   Live shift timer as the hero, with the 14-hour window as
 *             a progress bar. The visible running clock is the point:
 *             it's the cheapest defense we have against forgotten
 *             clock-outs, because a driver who sees "13h 40m" fixes it
 *             themselves. Note the timer counts the SHIFT while the bar
 *             tracks the WINDOW — after a short break those differ, and
 *             the window is the one with legal teeth.
 *
 *   STALE     The open shift itself has run past 14 hours, which is
 *             nearly always a missed clock-out. The timer becomes a
 *             "when did you finish?" prompt. Keyed off shift length,
 *             not the duty window: a driver two hours into a fresh
 *             shift but sixteen hours into a window has forgotten
 *             nothing and shouldn't be asked to correct a time that's
 *             already right.
 *
 * Every punch is correctable, both at the moment it's made (the Clock
 * In / Clock Out buttons offer "set a different time") and afterwards
 * (edit the running shift's start, or either end of the last one). A
 * driver whose only option is "now" will simply punch at the wrong time
 * and leave it wrong.
 *
 * The 70/8 cycle total is deliberately absent. It's only as good as a
 * week of clean clock-ins across the whole fleet; today's timer is only
 * as good as today. Fragile numbers stay where dispatch can check them.
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Modal, Platform, Alert } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Play, Square, Clock, AlertTriangle, Moon, FileText, Pencil } from "lucide-react-native";
import { useTheme } from "@/lib/ThemeProvider";
import type { HosStatusResponse, HosDutyOptions } from "@/lib/railway";

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

// ── Resolving a picked time to a moment ──────────────────────────────
//
// The picker only ever asks for a time of day, never a date. A driver
// fixing a punch is always talking about the last day or so, and "which
// date" is a question they shouldn't have to answer. We infer the
// calendar day from context instead — differently per field, which is
// why there are three of these rather than one.

/** Most recent occurrence of this time of day, at or before `now`.
 *  For a clock-in: a time that hasn't happened yet today means
 *  yesterday (started 11pm, fixing it at 1am). */
function resolveRecentPast(picked: Date, now: Date): Date {
  const at = new Date(now);
  at.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
  if (at.getTime() > now.getTime()) at.setTime(at.getTime() - 86400_000);
  return at;
}

/** First occurrence of this time of day strictly after `after`, or null
 *  if that lands in the future. For end times, which must sit between
 *  the shift's start and now — this is what makes an overnight shift
 *  resolve to the following morning rather than before its own start. */
function resolveAfter(picked: Date, after: Date, now: Date): Date | null {
  const at = new Date(after);
  at.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
  if (at.getTime() <= after.getTime()) at.setTime(at.getTime() + 86400_000);
  return at.getTime() > now.getTime() ? null : at;
}

/** This time of day on the same calendar date as `anchor`. For editing
 *  a start time, where the driver is nudging an existing timestamp
 *  rather than naming a fresh one. */
function resolveOnSameDay(picked: Date, anchor: Date): Date {
  const at = new Date(anchor);
  at.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
  return at;
}

/** Offers "now" vs "pick a time" vs cancel. Used by both punch buttons
 *  so a driver can correct at the moment of the punch, not only after. */
function offerPunchOptions(opts: {
  title: string;
  message: string;
  nowLabel: string;
  onNow: () => void;
  onPickTime: () => void;
}): void {
  Alert.alert(opts.title, opts.message, [
    { text: opts.nowLabel, onPress: opts.onNow },
    { text: "Set a different time", onPress: opts.onPickTime },
    { text: "Cancel", style: "cancel" },
  ]);
}

/** Time-of-day picker. iOS gets a spinner in a sheet (matching the
 *  profile screen's date picker); Android uses its native dialog. */
function TimePickerSheet({ initial, onCancel, onConfirm }: {
  initial: Date;
  onCancel: () => void;
  onConfirm: (picked: Date) => void;
}) {
  const { C, ACCENT } = useTheme();
  const [value, setValue] = useState(initial);

  if (Platform.OS !== "ios") {
    return (
      <DateTimePicker
        value={value}
        mode="time"
        display="default"
        onChange={(event, picked) => {
          if (event.type === "dismissed" || !picked) { onCancel(); return; }
          onConfirm(picked);
        }}
      />
    );
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onCancel}>
      <TouchableOpacity
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" }}
        activeOpacity={1}
        onPress={onCancel}
      >
        <TouchableOpacity activeOpacity={1} style={{ backgroundColor: C.surface, paddingBottom: 28 }}>
          <View style={{
            flexDirection: "row", alignItems: "center", justifyContent: "space-between",
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: 1, borderBottomColor: C.border,
          }}>
            <TouchableOpacity onPress={onCancel}>
              <Text style={[txt(600), { fontSize: 14, color: C.t2 }]}>Cancel</Text>
            </TouchableOpacity>
            <Text style={[txt(800), { fontSize: 14, color: C.t1 }]}>Select a time</Text>
            <TouchableOpacity onPress={() => onConfirm(value)}>
              <Text style={[txt(800), { fontSize: 14, color: ACCENT }]}>Done</Text>
            </TouchableOpacity>
          </View>
          <DateTimePicker
            value={value}
            mode="time"
            display="spinner"
            onChange={(_e, picked) => { if (picked) setValue(picked); }}
          />
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

/** Small pencil affordance, used wherever a recorded time can be
 *  changed. Hit area is padded well past the icon — this gets tapped
 *  with gloves on. */
function EditButton({ label, onPress, disabled }: {
  label: string; onPress: () => void; disabled?: boolean;
}) {
  const { C } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={{
        flexDirection: "row", alignItems: "center", gap: 5,
        paddingVertical: 6, paddingHorizontal: 10,
        borderRadius: 8, borderWidth: 1, borderColor: C.border,
        backgroundColor: C.surface2,
      }}
    >
      <Pencil size={12} color={C.t2} />
      <Text style={[txt(700), { fontSize: 11.5, color: C.t2 }]}>{label}</Text>
    </TouchableOpacity>
  );
}

interface Props {
  data:    HosStatusResponse | null;
  loading: boolean;
  busy:    boolean;
  /** `occurredAt` (ISO) backdates the punch; omitted means "now". */
  onClockIn:  (occurredAt?: string) => void;
  onClockOut: (occurredAt?: string) => void;
  /** Correct either end of any of this driver's shifts. */
  onCorrectShift: (shiftId: string, times: { startedAt?: string; endedAt?: string }) => void;
  /** Dismisses the stale prompt for this session when the driver really
   *  has been on duty this long. */
  onKeepRunning: () => void;
  staleDismissed: boolean;
}

export default function HosCard({
  data, loading, busy, onClockIn, onClockOut, onCorrectShift, onKeepRunning, staleDismissed,
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

  // The bar tracks the 14-hour WINDOW, which may have opened before
  // this shift did if the driver took a break under 10 hours.
  const windowStart = data?.dutyPeriodStart ?? shift?.startedAt ?? null;
  const windowElapsed = windowStart
    ? Math.max(0, (now - new Date(windowStart).getTime()) / 1000)
    : 0;
  const windowRemaining = Math.max(0, SHIFT_WINDOW_SECONDS - windowElapsed);

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

  // A previous shift auto-closed on an estimate. The driver is the only
  // one who knows the real end time, so give them a path to it here.
  const last = data.lastShift ?? null;
  const unresolved = last && last.autoClosed && last.needsReview ? last : null;

  if (onDuty && shift) {
    if (elapsed >= SHIFT_WINDOW_SECONDS && !staleDismissed) {
      return (
        <StalePrompt
          shiftId={shift.id}
          startedAt={shift.startedAt}
          elapsed={elapsed}
          busy={busy}
          onCorrectShift={onCorrectShift}
          onKeepRunning={onKeepRunning}
        />
      );
    }
    return (
      <>
        {unresolved && (
          <PreviousShiftBanner shift={unresolved} busy={busy} onCorrectShift={onCorrectShift} />
        )}
        <OnDutyCard
          shift={shift}
          elapsed={elapsed}
          windowElapsed={windowElapsed}
          windowRemaining={windowRemaining}
          busy={busy}
          onClockOut={onClockOut}
          onCorrectShift={onCorrectShift}
        />
      </>
    );
  }

  return (
    <>
      {unresolved && (
        <PreviousShiftBanner shift={unresolved} busy={busy} onCorrectShift={onCorrectShift} />
      )}
      <OffDutyCard
        data={data}
        busy={busy}
        onClockIn={onClockIn}
        onCorrectShift={onCorrectShift}
      />
    </>
  );
}

// ── Off duty ─────────────────────────────────────────────────────────

function OffDutyCard({ data, busy, onClockIn, onCorrectShift }: {
  data: HosStatusResponse;
  busy: boolean;
  onClockIn: (occurredAt?: string) => void;
  onCorrectShift: (shiftId: string, times: { startedAt?: string; endedAt?: string }) => void;
}) {
  const { C } = useTheme();
  const [picking, setPicking] = useState<null | "clock-in" | "last-start" | "last-end">(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const rest = data.rest ?? null;
  const last = data.lastShift ?? null;
  // Inside the 10-hour reset: warn, don't block.
  const resting = rest != null && !rest.satisfied;

  const accent   = resting ? C.amber   : C.green;
  const accentBg = resting ? C.amberBg : C.greenBg;
  const ink      = resting ? C.amberInk : C.greenInk;

  const editLastShift = () => {
    if (!last) return;
    setPickError(null);
    Alert.alert(
      "Edit last shift",
      `${fmtDayAndClock(last.startedAt)} to ${last.endedAt ? fmtDayAndClock(last.endedAt) : "unknown"}. Which time do you want to change?`,
      [
        { text: "Start time", onPress: () => setPicking("last-start") },
        { text: "End time",   onPress: () => setPicking("last-end") },
        { text: "Cancel", style: "cancel" },
      ],
    );
  };

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
        {last?.endedAt && <EditButton label="Edit" onPress={editLastShift} disabled={busy} />}
      </View>

      {resting && rest && (
        <DutyOptionsBox
          rest={rest}
          options={data.options ?? null}
          dutyPeriodStart={data.dutyPeriodStart ?? null}
        />
      )}

      {pickError && (
        <Text style={[txt(600), { fontSize: 12, color: C.redInk, marginBottom: 10 }]}>
          {pickError}
        </Text>
      )}

      <TouchableOpacity
        onPress={() => offerPunchOptions({
          title: "Clock in",
          message: "Start your shift now, or set the time you actually started.",
          nowLabel: "Clock in now",
          onNow: () => onClockIn(),
          onPickTime: () => { setPickError(null); setPicking("clock-in"); },
        })}
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

      {picking && (
        <TimePickerSheet
          initial={
            picking === "clock-in" ? new Date()
            : picking === "last-start" && last ? new Date(last.startedAt)
            : last?.endedAt ? new Date(last.endedAt) : new Date()
          }
          onCancel={() => setPicking(null)}
          onConfirm={(picked) => {
            const mode = picking;
            setPicking(null);
            const now = new Date();

            if (mode === "clock-in") {
              onClockIn(resolveRecentPast(picked, now).toISOString());
              return;
            }
            if (!last) return;

            if (mode === "last-start") {
              const at = resolveOnSameDay(picked, new Date(last.startedAt));
              if (last.endedAt && at.getTime() >= new Date(last.endedAt).getTime()) {
                setPickError("That start time is after the shift ended.");
                return;
              }
              if (at.getTime() > now.getTime()) {
                setPickError("That start time is in the future.");
                return;
              }
              onCorrectShift(last.id, { startedAt: at.toISOString() });
              return;
            }

            const at = resolveAfter(picked, new Date(last.startedAt), now);
            if (!at) {
              setPickError("That end time is either before the shift started or still in the future.");
              return;
            }
            onCorrectShift(last.id, { endedAt: at.toISOString() });
          }}
        />
      )}
    </View>
  );
}

/**
 * What an off-duty driver can do next.
 *
 * The 14-hour window keeps running while a driver is off duty — only a
 * full 10 hours off resets it. So a driver who clocked out mid-window
 * has two genuinely different options, and showing only the 10-hour
 * reset (as this box originally did) tells them they're stuck until
 * tomorrow when they could legally be working right now.
 *
 * Once the window has expired there's only one option left, and the box
 * collapses to it rather than listing a choice that isn't available.
 */
function DutyOptionsBox({ rest, options, dutyPeriodStart }: {
  rest: NonNullable<HosStatusResponse["rest"]>;
  options: HosDutyOptions | null;
  dutyPeriodStart: string | null;
}) {
  const { C } = useTheme();
  const canResume = options?.canResumeWithinWindow === true && options.windowEndsAt != null;

  return (
    <View style={{
      backgroundColor: C.amberBg, borderRadius: 10, padding: 12, marginBottom: 12,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: canResume ? 10 : 6 }}>
        <Clock size={14} color={C.amberInk} />
        <Text style={[txt(800), { fontSize: 12.5, color: C.amberInk }]}>
          {canResume ? "You have two options" : "Before your next shift"}
        </Text>
      </View>

      {canResume && options?.windowEndsAt ? (
        <>
          <Text style={[txt(700), { fontSize: 13, color: C.amberInk, marginBottom: 2 }]}>
            Keep working until {fmtClock(options.windowEndsAt)}
          </Text>
          <Text style={[txt(500), { fontSize: 12.5, color: C.amberInk, lineHeight: 18, marginBottom: 11 }]}>
            Your 14 hour window started
            {dutyPeriodStart ? ` at ${fmtClock(dutyPeriodStart)}` : ""} and runs
            until {fmtClock(options.windowEndsAt)}. Going off duty for a short break does not
            extend it, so you can go back on duty and finish out that window.
          </Text>

          <Text style={[txt(700), { fontSize: 13, color: C.amberInk, marginBottom: 2 }]}>
            Or take 10 hours off, ending {fmtClock(rest.clearAt)}
          </Text>
          <Text style={[txt(500), { fontSize: 12.5, color: C.amberInk, lineHeight: 18 }]}>
            10 hours off in a row starts a new 14 hour window. You have had
            {" "}{fmtDuration(rest.restSeconds)} so far.
          </Text>
        </>
      ) : (
        <Text style={[txt(500), { fontSize: 12.5, color: C.amberInk, lineHeight: 18 }]}>
          {options?.windowEndsAt
            ? "Your 14 hour window has ended, so you need 10 hours off in a row before you can start again. "
            : "You need 10 hours off in a row between shifts. "}
          You have had {fmtDuration(rest.restSeconds)} and will reach 10 hours
          at {fmtClock(rest.clearAt)}.
        </Text>
      )}
    </View>
  );
}

// ── On duty ──────────────────────────────────────────────────────────

function OnDutyCard({
  shift, elapsed, windowElapsed, windowRemaining, busy, onClockOut, onCorrectShift,
}: {
  shift: NonNullable<HosStatusResponse["currentShift"]>;
  elapsed: number; windowElapsed: number; windowRemaining: number; busy: boolean;
  onClockOut: (occurredAt?: string) => void;
  onCorrectShift: (shiftId: string, times: { startedAt?: string; endedAt?: string }) => void;
}) {
  const { C } = useTheme();
  const [picking, setPicking] = useState<null | "clock-out" | "edit-start">(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const pct = Math.min(1, windowElapsed / SHIFT_WINDOW_SECONDS);
  // Escalate as the window closes. 10h and 13h are judgement calls, not
  // regulatory thresholds — they exist to give a driver warning before
  // the number turns into a problem.
  const barColor = windowElapsed >= 13 * 3600 ? C.red : windowElapsed >= 10 * 3600 ? C.amber : C.green;
  const isOtr = shift.classification === "otr";

  return (
    <View style={[cardBase, { backgroundColor: C.surface, borderColor: C.border, padding: 0, overflow: "hidden" }]}>
      {isOtr && (
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 8,
          backgroundColor: C.blueBg, paddingHorizontal: 14, paddingVertical: 9,
        }}>
          <FileText size={14} color={C.blueInk} />
          <Text style={[txt(700), { fontSize: 12.5, color: C.blueInk, flex: 1 }]}>
            OTR run today
          </Text>
        </View>
      )}

      <View style={{ padding: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.green }} />
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

        <View style={{ marginTop: 4 }}>
          <EditButton
            label="Edit clock in time"
            onPress={() => { setPickError(null); setPicking("edit-start"); }}
            disabled={busy}
          />
        </View>

        <View style={{ marginTop: 14, marginBottom: 4 }}>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: C.surfaceSunk, overflow: "hidden" }}>
            <View style={{ width: `${pct * 100}%`, height: "100%", backgroundColor: barColor }} />
          </View>
          <Text style={[txt(600), { fontSize: 12, color: C.t2, marginTop: 7 }]}>
            {windowRemaining > 0
              ? `${fmtDuration(windowRemaining)} left in your 14 hour window`
              : "Your 14 hour window has ended"}
          </Text>
        </View>

        {pickError && (
          <Text style={[txt(600), { fontSize: 12, color: C.redInk, marginTop: 8 }]}>
            {pickError}
          </Text>
        )}

        <TouchableOpacity
          onPress={() => offerPunchOptions({
            title: "Clock out",
            message: "End your shift now, or set the time you actually finished. Your 10 hours off duty run from that time.",
            nowLabel: "Clock out now",
            onNow: () => onClockOut(),
            onPickTime: () => { setPickError(null); setPicking("clock-out"); },
          })}
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

        {picking && (
          <TimePickerSheet
            initial={picking === "edit-start" ? new Date(shift.startedAt) : new Date()}
            onCancel={() => setPicking(null)}
            onConfirm={(picked) => {
              const mode = picking;
              setPicking(null);
              const now = new Date();

              if (mode === "edit-start") {
                const at = resolveOnSameDay(picked, new Date(shift.startedAt));
                if (at.getTime() > now.getTime()) {
                  setPickError("That start time is in the future.");
                  return;
                }
                onCorrectShift(shift.id, { startedAt: at.toISOString() });
                return;
              }

              const at = resolveAfter(picked, new Date(shift.startedAt), now);
              if (!at) {
                setPickError("That time is either before your shift started or still in the future.");
                return;
              }
              onClockOut(at.toISOString());
            }}
          />
        )}
      </View>
    </View>
  );
}

// ── Previous shift left on an estimated end time ─────────────────────

function PreviousShiftBanner({ shift, busy, onCorrectShift }: {
  shift: NonNullable<HosStatusResponse["lastShift"]>;
  busy: boolean;
  onCorrectShift: (shiftId: string, times: { startedAt?: string; endedAt?: string }) => void;
}) {
  const { C } = useTheme();
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  return (
    <View style={[cardBase, {
      backgroundColor: C.amberBg, borderColor: C.amber, marginBottom: 10,
    }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <AlertTriangle size={15} color={C.amberInk} />
        <Text style={[txt(800), { fontSize: 14, color: C.amberInk }]}>
          Previous shift needs an end time
        </Text>
      </View>
      <Text style={[txt(600), { fontSize: 12.5, color: C.amberInk, lineHeight: 18 }]}>
        Your shift from {fmtDayAndClock(shift.startedAt)} was closed with an estimated time
        of {shift.endedAt ? fmtDayAndClock(shift.endedAt) : "unknown"}. Set the time you
        actually finished.
      </Text>

      <TouchableOpacity
        disabled={busy}
        onPress={() => { setPickError(null); setPicking(true); }}
        activeOpacity={0.85}
        style={{
          alignItems: "center", marginTop: 12,
          backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
          paddingVertical: 12, borderRadius: 11,
        }}
      >
        <Text style={[txt(700), { fontSize: 14, color: C.t1 }]}>Edit the end time</Text>
      </TouchableOpacity>

      {pickError && (
        <Text style={[txt(600), { fontSize: 12, color: C.redInk, marginTop: 8 }]}>
          {pickError}
        </Text>
      )}

      {picking && (
        <TimePickerSheet
          initial={shift.endedAt ? new Date(shift.endedAt) : new Date()}
          onCancel={() => setPicking(false)}
          onConfirm={(picked) => {
            setPicking(false);
            const at = resolveAfter(picked, new Date(shift.startedAt), new Date());
            if (!at) {
              setPickError("That time is either before that shift started or still in the future.");
              return;
            }
            onCorrectShift(shift.id, { endedAt: at.toISOString() });
          }}
        />
      )}
    </View>
  );
}

// ── Stale (missed clock-out) ─────────────────────────────────────────

function StalePrompt({ shiftId, startedAt, elapsed, busy, onCorrectShift, onKeepRunning }: {
  shiftId: string; startedAt: string; elapsed: number; busy: boolean;
  onCorrectShift: (shiftId: string, times: { startedAt?: string; endedAt?: string }) => void;
  onKeepRunning: () => void;
}) {
  const { C } = useTheme();
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
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
        <Text style={[txt(800), { fontSize: 15, color: C.amberInk }]}>
          Your shift is still open
        </Text>
      </View>
      <Text style={[txt(600), { fontSize: 13, color: C.amberInk, marginBottom: 14, lineHeight: 19 }]}>
        This shift started {fmtDayAndClock(startedAt)} and has been running for {fmtDuration(elapsed)},
        which is longer than a 14 hour window allows. Select the time you finished so your hours
        are recorded correctly.
      </Text>

      <View style={{ gap: 8 }}>
        {picks.map(p => (
          <TouchableOpacity
            key={p.hours}
            disabled={busy}
            onPress={() => onCorrectShift(shiftId, { endedAt: p.at.toISOString() })}
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

        <TouchableOpacity
          disabled={busy}
          onPress={() => { setPickError(null); setPicking(true); }}
          activeOpacity={0.85}
          style={{
            alignItems: "center",
            backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
            paddingVertical: 13, paddingHorizontal: 14, borderRadius: 11,
          }}
        >
          <Text style={[txt(700), { fontSize: 14.5, color: C.t1 }]}>
            Select a specific time
          </Text>
        </TouchableOpacity>
      </View>

      {pickError && (
        <Text style={[txt(600), { fontSize: 12, color: C.redInk, marginTop: 10 }]}>
          {pickError}
        </Text>
      )}

      <TouchableOpacity
        onPress={onKeepRunning}
        disabled={busy}
        style={{ paddingVertical: 12, alignItems: "center", marginTop: 4 }}
      >
        <Text style={[txt(700), { fontSize: 13.5, color: C.amberInk }]}>
          I am still on duty
        </Text>
      </TouchableOpacity>

      {picking && (
        <TimePickerSheet
          initial={new Date()}
          onCancel={() => setPicking(false)}
          onConfirm={(picked) => {
            setPicking(false);
            const at = resolveAfter(picked, new Date(startedAt), new Date());
            if (!at) {
              setPickError("That time is either before your shift started or still in the future.");
              return;
            }
            onCorrectShift(shiftId, { endedAt: at.toISOString() });
          }}
        />
      )}
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
