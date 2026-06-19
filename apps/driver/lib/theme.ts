/**
 * FleetCal driver-app design tokens — light + dark palettes.
 *
 * Components read the ACTIVE palette via `useTheme()` (see ThemeProvider.tsx):
 *   const { C, SHADOW, ACCENT } = useTheme();
 * and keep their `C.bg` / `SHADOW.card` / `ACCENT` references unchanged.
 *
 * Static `C` / `SHADOW` / `ACCENT` / … exports below are the LIGHT palette,
 * kept for any module not yet migrated to `useTheme()` (they just stay light).
 *
 * Mirrors the design handoff's `driver-redesign.css` (`:root` + the
 * `[data-theme="dark"]` block).
 */
import type { TextStyle, ViewStyle } from "react-native";

/* ---- Type ---- */
export const FONT = {
  w500: "PlusJakartaSans_500Medium",
  w600: "PlusJakartaSans_600SemiBold",
  w700: "PlusJakartaSans_700Bold",
  w800: "PlusJakartaSans_800ExtraBold",
  mono:     "JetBrainsMono_600SemiBold",
  monoBold: "JetBrainsMono_700Bold",
} as const;

/** Plus Jakarta weight helper — `f(800)` → the ExtraBold family. */
export function f(weight: 500 | 600 | 700 | 800): TextStyle {
  return {
    fontFamily:
      weight === 500 ? FONT.w500 :
      weight === 600 ? FONT.w600 :
      weight === 700 ? FONT.w700 :
                       FONT.w800,
  };
}

/* ---- Spacing (roomy density) ---- */
export const SP = { cpad: 18, stack: 15, cgap: 13, screenPx: 18 } as const;

/* ---- Radii ---- */
export const RADIUS = {
  card: 20, tile: 16, stop: 18, headerList: 24, headerDetail: 22,
  pill: 999, chip: 7, btn: 14, sheet: 26, iconBtn: 14, stopNum: 12,
} as const;

export type Colors = {
  bg: string; bgGradA: string; bgGradB: string;
  surface: string; surface2: string; surfaceSunk: string;
  border: string; borderSoft: string; borderStrong: string;
  t1: string; t2: string; t3: string; t4: string;
  blue: string; blueInk: string; blueBg: string;
  green: string; greenInk: string; greenBg: string;
  red: string; redInk: string; redBg: string;
  amber: string; amberInk: string; amberBg: string;
  purple: string; purpleInk: string; purpleBg: string;
  mapBg: string; mapLand: string; mapRoad: string; mapRoad2: string;
};

const lightC: Colors = {
  bg: "#eef1f5", bgGradA: "#eef2f7", bgGradB: "#e7ebf1",
  surface: "#ffffff", surface2: "#f5f7fa", surfaceSunk: "#eef1f5",
  border: "#e4e7ec", borderSoft: "#edeff3", borderStrong: "#d6dbe2",
  t1: "#161b22", t2: "#495059", t3: "#7b838d", t4: "#a4abb4",
  blue: "#1a73e8", blueInk: "#1457c4", blueBg: "#e8f0fe",
  green: "#1a8a45", greenInk: "#137a3b", greenBg: "#e3f4e9",
  red: "#d6342a", redInk: "#b8261d", redBg: "#fdeae8",
  amber: "#c2700a", amberInk: "#9a5500", amberBg: "#fdf1dc",
  purple: "#7a2fb8", purpleInk: "#6321a0", purpleBg: "#f3e8fd",
  mapBg: "#dfe6ee", mapLand: "#e8edf3", mapRoad: "#ffffff", mapRoad2: "#c9d3df",
};

const darkC: Colors = {
  bg: "#0a0e14", bgGradA: "#0c1118", bgGradB: "#080b10",
  surface: "#151b24", surface2: "#1b222c", surfaceSunk: "#0e131a",
  border: "#262e3a", borderSoft: "#1f2630", borderStrong: "#323c4a",
  t1: "#f1f4f9", t2: "#b6bfca", t3: "#9aa3af", t4: "#78818d",
  blue: "#5b9bff", blueInk: "#8fbaff", blueBg: "rgba(91,155,255,0.16)",
  green: "#46c178", greenInk: "#7fd6a1", greenBg: "rgba(70,193,120,0.16)",
  red: "#ff6a5e", redInk: "#ff968d", redBg: "rgba(255,106,94,0.15)",
  amber: "#f0a637", amberInk: "#f6c277", amberBg: "rgba(240,166,55,0.15)",
  purple: "#b57be8", purpleInk: "#cda3f2", purpleBg: "rgba(181,123,232,0.16)",
  mapBg: "#10161e", mapLand: "#161d27", mapRoad: "#283341", mapRoad2: "#1f2832",
};

const lightShadow: Record<"card" | "pop" | "float" | "glass", ViewStyle> = {
  card:  { shadowColor: "#101828", shadowOpacity: 0.10, shadowRadius: 8,  shadowOffset: { width: 0, height: 2 },  elevation: 2 },
  pop:   { shadowColor: "#101828", shadowOpacity: 0.24, shadowRadius: 26, shadowOffset: { width: 0, height: 12 }, elevation: 14 },
  float: { shadowColor: "#101828", shadowOpacity: 0.14, shadowRadius: 24, shadowOffset: { width: 0, height: -2 }, elevation: 10 },
  glass: { shadowColor: "#101828", shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 8 },  elevation: 10 },
};
const darkShadow: Record<"card" | "pop" | "float" | "glass", ViewStyle> = {
  card:  { shadowColor: "#000000", shadowOpacity: 0.45, shadowRadius: 8,  shadowOffset: { width: 0, height: 2 },  elevation: 2 },
  pop:   { shadowColor: "#000000", shadowOpacity: 0.65, shadowRadius: 26, shadowOffset: { width: 0, height: 12 }, elevation: 14 },
  float: { shadowColor: "#000000", shadowOpacity: 0.5,  shadowRadius: 24, shadowOffset: { width: 0, height: -2 }, elevation: 10 },
  glass: { shadowColor: "#000000", shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 8 },  elevation: 10 },
};

function statusPill(c: Colors): Record<string, { bg: string; fg: string }> {
  return {
    scheduled:  { bg: c.surfaceSunk, fg: c.t3 },
    assigned:   { bg: c.purpleBg,    fg: c.purpleInk },
    dispatched: { bg: c.blueBg,      fg: c.blueInk },
    en_route:   { bg: c.amberBg,     fg: c.amberInk },
    picked_up:  { bg: c.purpleBg,    fg: c.purpleInk },
    delivered:  { bg: c.greenBg,     fg: c.greenInk },
    cancelled:  { bg: c.redBg,       fg: c.redInk },
    tonu:       { bg: c.amberBg,     fg: c.amberInk },
    problem:    { bg: c.redBg,       fg: c.redInk },
  };
}
function stopSolid(c: Colors): Record<string, string> {
  return { pickup: c.green, delivery: c.red, drop_hook: c.blue, drop: c.blue, stop: c.amber, relay: c.purple };
}
function stopTint(c: Colors): Record<string, { bg: string; fg: string }> {
  return {
    pickup:    { bg: c.greenBg,  fg: c.greenInk },
    delivery:  { bg: c.redBg,    fg: c.redInk },
    drop_hook: { bg: c.blueBg,   fg: c.blueInk },
    drop:      { bg: c.blueBg,   fg: c.blueInk },
    stop:      { bg: c.amberBg,  fg: c.amberInk },
    relay:     { bg: c.purpleBg, fg: c.purpleInk },
  };
}
function schedTint(c: Colors): Record<"APPT" | "WINDOW" | "FCFS", { bg: string; fg: string }> {
  return {
    APPT:   { bg: c.redBg,       fg: c.redInk },
    WINDOW: { bg: c.blueBg,      fg: c.blueInk },
    FCFS:   { bg: c.surfaceSunk, fg: c.t3 },
  };
}

export type Palette = {
  C: Colors;
  SHADOW: Record<"card" | "pop" | "float" | "glass", ViewStyle>;
  ACCENT: string; ACCENT_INK: string; ACCENT_BG: string;
  STATUS_PILL: Record<string, { bg: string; fg: string }>;
  STOP_SOLID: Record<string, string>;
  STOP_TINT: Record<string, { bg: string; fg: string }>;
  SCHED_TINT: Record<"APPT" | "WINDOW" | "FCFS", { bg: string; fg: string }>;
  isDark: boolean;
  /** Frosted-surface fill colors for the Glass component. */
  glassFill: string; glassFillDeep: string; glassHair: string;
};

function build(c: Colors, shadow: Palette["SHADOW"], isDark: boolean): Palette {
  return {
    C: c, SHADOW: shadow,
    ACCENT: c.blue, ACCENT_INK: c.blueInk, ACCENT_BG: c.blueBg,
    STATUS_PILL: statusPill(c), STOP_SOLID: stopSolid(c), STOP_TINT: stopTint(c), SCHED_TINT: schedTint(c),
    isDark,
    glassFill:     isDark ? "rgba(20,26,34,0.72)" : "rgba(255,255,255,0.85)",
    glassFillDeep: isDark ? "rgba(20,26,34,0.86)" : "rgba(255,255,255,0.94)",
    glassHair:     isDark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.9)",
  };
}

export const LIGHT = build(lightC, lightShadow, false);
export const DARK  = build(darkC, darkShadow, true);

/* ---- Static LIGHT exports (back-compat for modules not yet on useTheme) ---- */
export const C           = LIGHT.C;
export const SHADOW      = LIGHT.SHADOW;
export const ACCENT      = LIGHT.ACCENT;
export const ACCENT_INK  = LIGHT.ACCENT_INK;
export const ACCENT_BG   = LIGHT.ACCENT_BG;
export const STATUS_PILL = LIGHT.STATUS_PILL;
export const STOP_SOLID  = LIGHT.STOP_SOLID;
export const STOP_TINT   = LIGHT.STOP_TINT;
export const SCHED_TINT  = LIGHT.SCHED_TINT;
