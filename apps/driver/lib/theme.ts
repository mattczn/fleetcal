/**
 * FleetCal driver-app design tokens — the single source of truth for the
 * redesigned Loads list + Load detail screens. Mirrors the design handoff's
 * `driver-redesign.css` custom properties (light mode), so anything that
 * referenced a `--token` there maps to a value here instead of a stray hex.
 *
 * Light mode only for now (the app is `userInterfaceStyle: "light"`). The
 * structure intentionally keeps colors in one object so a dark set can be
 * layered later without touching call sites.
 */
import type { TextStyle, ViewStyle } from "react-native";

/* ---- Colors (light) ---- */
export const C = {
  bg:           "#eef1f5",
  bgGradA:      "#eef2f7",
  bgGradB:      "#e7ebf1",
  surface:      "#ffffff",
  surface2:     "#f5f7fa",
  surfaceSunk:  "#eef1f5",
  border:       "#e4e7ec",
  borderSoft:   "#edeff3",
  borderStrong: "#d6dbe2",

  t1: "#161b22",
  t2: "#495059",
  t3: "#7b838d",
  t4: "#a4abb4",

  blue:   "#1a73e8", blueInk:   "#1457c4", blueBg:   "#e8f0fe",
  green:  "#1a8a45", greenInk:  "#137a3b", greenBg:  "#e3f4e9",
  red:    "#d6342a", redInk:    "#b8261d", redBg:    "#fdeae8",
  amber:  "#c2700a", amberInk:  "#9a5500", amberBg:  "#fdf1dc",
  purple: "#7a2fb8", purpleInk: "#6321a0", purpleBg: "#f3e8fd",

  /* map placeholder */
  mapBg: "#dfe6ee", mapLand: "#e8edf3", mapRoad: "#ffffff", mapRoad2: "#c9d3df",
} as const;

/* Accent = blue (the brand default; the design's other accents aren't wired) */
export const ACCENT     = C.blue;
export const ACCENT_INK = C.blueInk;
export const ACCENT_BG  = C.blueBg;

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

/* ---- Shadows (RN translation of the CSS shadow tokens) ---- */
export const SHADOW: Record<"card" | "pop" | "float" | "glass", ViewStyle> = {
  card:  { shadowColor: "#101828", shadowOpacity: 0.10, shadowRadius: 8,  shadowOffset: { width: 0, height: 2 },  elevation: 2 },
  pop:   { shadowColor: "#101828", shadowOpacity: 0.24, shadowRadius: 26, shadowOffset: { width: 0, height: 12 }, elevation: 14 },
  float: { shadowColor: "#101828", shadowOpacity: 0.14, shadowRadius: 24, shadowOffset: { width: 0, height: -2 }, elevation: 10 },
  glass: { shadowColor: "#101828", shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 8 },  elevation: 10 },
};

/* ---- Spacing (roomy density) ---- */
export const SP = { cpad: 18, stack: 15, cgap: 13, screenPx: 18 } as const;

/* ---- Radii ---- */
export const RADIUS = {
  card: 20, tile: 16, stop: 18, headerList: 24, headerDetail: 22,
  pill: 999, chip: 7, btn: 14, sheet: 26, iconBtn: 14, stopNum: 12,
} as const;

/* ---- Status pill → tint (design tokens). `scheduled` shows no pill. ---- */
export const STATUS_PILL: Record<string, { bg: string; fg: string }> = {
  scheduled:  { bg: C.surfaceSunk, fg: C.t3 },
  assigned:   { bg: C.purpleBg,    fg: C.purpleInk },
  dispatched: { bg: C.blueBg,      fg: C.blueInk },
  en_route:   { bg: C.amberBg,     fg: C.amberInk },
  picked_up:  { bg: C.purpleBg,    fg: C.purpleInk },
  delivered:  { bg: C.greenBg,     fg: C.greenInk },
  cancelled:  { bg: C.redBg,       fg: C.redInk },
  tonu:       { bg: C.amberBg,     fg: C.amberInk },
  problem:    { bg: C.redBg,       fg: C.redInk },
};

/* ---- Stop type → solid color (number tile) + tint (type chip) ---- */
export const STOP_SOLID: Record<string, string> = {
  pickup: C.green, delivery: C.red, drop_hook: C.blue, drop: C.blue, stop: C.amber, relay: C.purple,
};
export const STOP_TINT: Record<string, { bg: string; fg: string }> = {
  pickup:    { bg: C.greenBg,  fg: C.greenInk },
  delivery:  { bg: C.redBg,    fg: C.redInk },
  drop_hook: { bg: C.blueBg,   fg: C.blueInk },
  drop:      { bg: C.blueBg,   fg: C.blueInk },
  stop:      { bg: C.amberBg,  fg: C.amberInk },
  relay:     { bg: C.purpleBg, fg: C.purpleInk },
};

/* Schedule-type mini-chip → tint (APPT strict / WINDOW flexible / FCFS none) */
export const SCHED_TINT: Record<"APPT" | "WINDOW" | "FCFS", { bg: string; fg: string }> = {
  APPT:   { bg: C.redBg,      fg: C.redInk },
  WINDOW: { bg: C.blueBg,     fg: C.blueInk },
  FCFS:   { bg: C.surfaceSunk, fg: C.t3 },
};
