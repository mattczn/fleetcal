/**
 * Shared toggle for "show times in stop's tz" vs "show times in
 * device's tz". Persisted to AsyncStorage so the choice survives
 * relaunches. Cross-screen sync via a module-local subscriber list,
 * so flipping the toggle on the load detail also updates the schedule
 * list without a remount.
 */
import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type TzMode = "stop" | "device";
const STORAGE_KEY = "driver.tzMode.v1";

let cached: TzMode = "stop";
let hydrated = false;
const listeners = new Set<(m: TzMode) => void>();

async function loadFromStorage(): Promise<TzMode> {
  if (hydrated) return cached;
  try {
    const v = await AsyncStorage.getItem(STORAGE_KEY);
    if (v === "device" || v === "stop") cached = v;
  } catch {/* ignore */}
  hydrated = true;
  return cached;
}

function persist(mode: TzMode): void {
  cached = mode;
  AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => {/* ignore */});
  for (const l of listeners) l(mode);
}

/** Read + write hook. Default is "stop" (show stop's local tz);
 *  toggle to "device" to convert everything to the phone's tz. */
export function useTzMode(): [TzMode, (mode: TzMode) => void] {
  const [mode, setMode] = useState<TzMode>(cached);

  useEffect(() => {
    let cancelled = false;
    void loadFromStorage().then((m) => { if (!cancelled) setMode(m); });
    const listener = (m: TzMode) => setMode(m);
    listeners.add(listener);
    return () => { cancelled = true; listeners.delete(listener); };
  }, []);

  const set = useCallback((m: TzMode) => persist(m), []);
  return [mode, set];
}
