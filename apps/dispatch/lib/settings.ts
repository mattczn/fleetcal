import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

const KEY_DRIVER_PAY_PCT = "settings:driverPayPct";
const DEFAULT_DRIVER_PAY_PCT = 25;

/**
 * Hook for the org's driver-pay percentage. Backed by AsyncStorage so each
 * device persists its own copy (mirrors web's localStorage approach until we
 * sync via the DB). Returns null while the value is loading.
 */
export function useDriverPayPct(): {
  pct: number | null;
  setPct: (next: number | null) => Promise<void>;
} {
  const [pct, set] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(KEY_DRIVER_PAY_PCT).then((raw) => {
      if (cancelled) return;
      if (raw == null) { set(DEFAULT_DRIVER_PAY_PCT); return; }
      const n = parseFloat(raw);
      set(Number.isFinite(n) ? n : DEFAULT_DRIVER_PAY_PCT);
    });
    return () => { cancelled = true; };
  }, []);

  const setPct = useCallback(async (next: number | null) => {
    if (next == null) {
      await AsyncStorage.removeItem(KEY_DRIVER_PAY_PCT);
      set(DEFAULT_DRIVER_PAY_PCT);
      return;
    }
    const clamped = Math.max(0, Math.min(100, next));
    await AsyncStorage.setItem(KEY_DRIVER_PAY_PCT, String(clamped));
    set(clamped);
  }, []);

  return { pct, setPct };
}
