/**
 * Theme context — provides the active (light/dark) palette to the app and
 * a Light/Dark toggle that persists to AsyncStorage. This is an in-app
 * preference (not the OS appearance), so it works over-the-air without a
 * native rebuild. Default is light.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LIGHT, DARK, type Palette } from "@/lib/theme";

export type ThemeMode = "light" | "dark";
type ThemeContextValue = Palette & {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
};

const STORAGE_KEY = "fc.driver.themeMode";

const ThemeContext = createContext<ThemeContextValue>({
  ...LIGHT, mode: "light", setMode: () => {}, toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("light");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => { if (v === "dark" || v === "light") setModeState(v); })
      .catch(() => {});
  }, []);

  const persist = (m: ThemeMode) => { AsyncStorage.setItem(STORAGE_KEY, m).catch(() => {}); };
  const setMode = useCallback((m: ThemeMode) => { setModeState(m); persist(m); }, []);
  const toggle = useCallback(() => {
    setModeState((m) => { const next = m === "dark" ? "light" : "dark"; persist(next); return next; });
  }, []);

  const palette = mode === "dark" ? DARK : LIGHT;
  const value: ThemeContextValue = { ...palette, mode, setMode, toggle };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
