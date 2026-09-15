/**
 * Background location tracking for an open timesheet shift.
 *
 * While someone is clocked in, the OS wakes us roughly every 10 minutes
 * with a position. Samples are buffered on disk and flushed to
 * /v1/timesheets/:id/pings; the buffer is what makes this survive a
 * shop with no signal, which is the normal case rather than the edge.
 *
 * ── Why a buffer and not a direct POST per sample ─────────────────────
 *
 * The background task gets a few seconds of runtime and no guarantee of
 * network. A POST that fails there is simply lost — there is no UI to
 * show an error to and no retry loop alive to catch it. So the task
 * does the one thing that cannot fail (append to AsyncStorage) and the
 * flush happens opportunistically, both from the task itself and from
 * the foreground whenever the timesheet screen is looked at.
 *
 * Duplicate delivery is expected as a result: a flush that times out
 * after the server committed will be retried with the same samples.
 * That is safe because the server upserts on (shift_id, at) — see
 * UNIQUE timesheet_pings_unique_sample. Never "fix" the double-send by
 * dropping the buffer before the response lands; losing samples is the
 * worse failure.
 *
 * ── The permission this depends on ────────────────────────────────────
 *
 * Background delivery needs iOS "Always". Users routinely pick "While
 * Using" instead, and iOS re-prompts later to downgrade. When that
 * happens the OS simply stops waking us — no error, no callback. A
 * shift with no pings after 9:15am then looks exactly like someone who
 * stood still all afternoon.
 *
 * `markTrackingStopped` records the moment we noticed, and clock-out
 * sends it so the reviewer sees "tracking stopped at 9:15" rather than
 * drawing the wrong conclusion from an empty map. Read
 * `getTrackingHealth()` before trusting a sparse trail.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { railway } from "./railway";

export const SHIFT_LOCATION_TASK = "fleetcal-shift-location";

/** ~10 minutes between samples, per the spec for this feature. iOS
 *  treats these as hints and may coalesce or delay them — the interval
 *  is a floor on battery cost, not a promise about spacing. */
const PING_INTERVAL_MS  = 10 * 60 * 1000;
const PING_DISTANCE_M   = 50;

const KEY_BUFFER   = "timesheet:pingBuffer";
const KEY_SHIFT_ID = "timesheet:activeShiftId";
const KEY_HEALTH   = "timesheet:trackingHealth";

/** Hard cap so a long offline stretch can't grow the buffer without
 *  bound. At one sample per 10 minutes this is about 41 days. */
const MAX_BUFFERED = 6000;

export interface BufferedPing {
  at:  string;
  lat: number;
  lng: number;
  accuracy?: number;
}

interface TrackingHealth {
  /** ISO time we noticed background updates were no longer permitted. */
  stoppedAt?: string;
  /** Last permission status we observed, for display. */
  lastStatus?: string;
}

// ── Buffer ───────────────────────────────────────────────────────────

async function readBuffer(): Promise<BufferedPing[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_BUFFER);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as BufferedPing[] : [];
  } catch {
    // A corrupt buffer must not wedge tracking forever. Drop it and
    // keep sampling — losing a few pins beats never recording again.
    return [];
  }
}

async function writeBuffer(pings: BufferedPing[]): Promise<void> {
  const trimmed = pings.length > MAX_BUFFERED ? pings.slice(-MAX_BUFFERED) : pings;
  try {
    await AsyncStorage.setItem(KEY_BUFFER, JSON.stringify(trimmed));
  } catch {
    /* Out of disk is not recoverable here; the next sample retries. */
  }
}

async function appendToBuffer(ping: BufferedPing): Promise<void> {
  const buf = await readBuffer();
  buf.push(ping);
  await writeBuffer(buf);
}

// ── Health ───────────────────────────────────────────────────────────

export async function getTrackingHealth(): Promise<TrackingHealth> {
  try {
    const raw = await AsyncStorage.getItem(KEY_HEALTH);
    return raw ? JSON.parse(raw) as TrackingHealth : {};
  } catch {
    return {};
  }
}

async function setTrackingHealth(next: TrackingHealth): Promise<void> {
  try { await AsyncStorage.setItem(KEY_HEALTH, JSON.stringify(next)); } catch { /* best effort */ }
}

/** Record that background updates are no longer being delivered. Only
 *  the FIRST such moment is kept — the reviewer wants to know when the
 *  trail went dark, not when we last re-checked. */
export async function markTrackingStopped(status?: string): Promise<void> {
  const cur = await getTrackingHealth();
  if (cur.stoppedAt) {
    if (status && status !== cur.lastStatus) await setTrackingHealth({ ...cur, lastStatus: status });
    return;
  }
  await setTrackingHealth({ stoppedAt: new Date().toISOString(), lastStatus: status });
}

async function clearTrackingHealth(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY_HEALTH); } catch { /* best effort */ }
}

// ── Active shift id (shared with the background task) ────────────────
//
// The task runs in its own JS context with no access to React state, so
// the shift it belongs to has to come off disk.

export async function setActiveShiftId(shiftId: string | null): Promise<void> {
  try {
    if (shiftId) await AsyncStorage.setItem(KEY_SHIFT_ID, shiftId);
    else         await AsyncStorage.removeItem(KEY_SHIFT_ID);
  } catch { /* best effort */ }
}

export async function getActiveShiftId(): Promise<string | null> {
  try { return await AsyncStorage.getItem(KEY_SHIFT_ID); } catch { return null; }
}

// ── Flush ────────────────────────────────────────────────────────────

/**
 * Send whatever is buffered for `shiftId`. Returns how many samples
 * were accepted, or null if there was nothing to send.
 *
 * The buffer is cleared ONLY after the server confirms. Anything that
 * arrived while the request was in flight is preserved — hence the
 * re-read and slice rather than a blanket remove.
 */
export async function flushPings(shiftId: string): Promise<number | null> {
  const buf = await readBuffer();
  if (buf.length === 0) return null;

  // Send at most one server batch per call (the route caps at 500).
  const batch = buf.slice(0, 500);
  try {
    const res = await railway.uploadTimesheetPings(shiftId, { pings: batch });
    const after = await readBuffer();
    await writeBuffer(after.slice(batch.length));
    return res.inserted;
  } catch {
    // Keep the buffer intact and try again later. A failed flush is
    // normal in a shop; it is not an error worth surfacing.
    return null;
  }
}

// ── The background task ──────────────────────────────────────────────
//
// Defined at module scope, which is a requirement: TaskManager has to
// find this registration when the OS relaunches the app into the
// background, before any screen has mounted. Importing this module from
// the root layout is what guarantees that.
TaskManager.defineTask(SHIFT_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn("[shiftTracking] task error:", error);
    return;
  }
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  if (!locations || locations.length === 0) return;

  const shiftId = await getActiveShiftId();
  // No open shift means we are tracking something we shouldn't be.
  // Stop rather than quietly collecting location off the clock — that
  // is the promise the permission prompt makes.
  if (!shiftId) {
    await stopShiftTracking();
    return;
  }

  for (const loc of locations) {
    await appendToBuffer({
      at:  new Date(loc.timestamp).toISOString(),
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      accuracy: typeof loc.coords.accuracy === "number" ? loc.coords.accuracy : undefined,
    });
  }

  // Opportunistic — if there's signal right now, spend it.
  await flushPings(shiftId);
});

// ── Start / stop ─────────────────────────────────────────────────────

export type StartTrackingResult =
  | { ok: true }
  | { ok: false; reason: "foreground_denied" | "background_denied" | "unavailable" };

/**
 * Ask for permission and begin background updates.
 *
 * Deliberately returns a reason instead of throwing or alerting: the
 * CALLER decides what a refusal means. Clocking in must still succeed
 * when location is denied — an hour recorded without a trail beats an
 * hour not recorded because the mechanic said no to a prompt.
 */
export async function startShiftTracking(shiftId: string): Promise<StartTrackingResult> {
  await setActiveShiftId(shiftId);

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") {
    await markTrackingStopped(fg.status);
    return { ok: false, reason: "foreground_denied" };
  }

  // iOS requires foreground to be granted before "Always" can even be
  // asked for, which is why this is a second call and not one prompt.
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== "granted") {
    await markTrackingStopped(bg.status);
    return { ok: false, reason: "background_denied" };
  }

  try {
    const already = await Location.hasStartedLocationUpdatesAsync(SHIFT_LOCATION_TASK);
    if (already) { await clearTrackingHealth(); return { ok: true }; }

    await Location.startLocationUpdatesAsync(SHIFT_LOCATION_TASK, {
      accuracy:          Location.Accuracy.Balanced,
      timeInterval:      PING_INTERVAL_MS,
      distanceInterval:  PING_DISTANCE_M,
      // Without this iOS will pause updates when it decides the device
      // has been stationary "long enough" — which is precisely the
      // situation we still want recorded. A mechanic under the same
      // truck for three hours is a real answer to "where is he".
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "FleetCal Go — on the clock",
        notificationBody:  "Recording your location while you are clocked in.",
        notificationColor: "#1a73e8",
      },
    });
    await clearTrackingHealth();
    return { ok: true };
  } catch (err) {
    console.warn("[shiftTracking] startLocationUpdatesAsync failed:", err);
    await markTrackingStopped("start_failed");
    return { ok: false, reason: "unavailable" };
  }
}

/** Stop background updates. Safe to call when not running. */
export async function stopShiftTracking(): Promise<void> {
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(SHIFT_LOCATION_TASK);
    if (running) await Location.stopLocationUpdatesAsync(SHIFT_LOCATION_TASK);
  } catch (err) {
    console.warn("[shiftTracking] stop failed:", err);
  }
  await setActiveShiftId(null);
}

/**
 * Re-check that background updates are still permitted and running, and
 * record the moment they aren't.
 *
 * Call this whenever the timesheet screen comes into focus. It is the
 * only way to notice an "Always" → "While Using" downgrade: iOS does
 * not tell us, it just stops calling. Returns true when healthy.
 */
export async function verifyTrackingAlive(): Promise<boolean> {
  try {
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.status !== "granted") {
      await markTrackingStopped(bg.status);
      return false;
    }
    const running = await Location.hasStartedLocationUpdatesAsync(SHIFT_LOCATION_TASK);
    if (!running) {
      // Permission is fine but the task isn't registered — the app was
      // reinstalled or the OS dropped it. Restart rather than report a
      // permission problem the user can't act on.
      const shiftId = await getActiveShiftId();
      if (shiftId) {
        const res = await startShiftTracking(shiftId);
        return res.ok;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Number of samples waiting to upload — shown on the timesheet screen
 *  so a mechanic can see the app is holding data, not losing it. */
export async function bufferedPingCount(): Promise<number> {
  return (await readBuffer()).length;
}
