/**
 * @fleetcal/tokens — design tokens shared across all FleetCal apps.
 *
 * Authored as CommonJS so the file can be consumed by:
 *   - apps/web/tailwind.config.ts        (Tailwind v4)
 *   - apps/driver/tailwind.config.js     (NativeWind v2, Node require)
 *   - apps/dispatch                      (Phase 5)
 *
 * Type definitions live in index.d.ts.
 *
 * Seeded from apps/driver/tailwind.config.js (the most coherent token system
 * pre-Phase-1).
 */

// ── Colors ──────────────────────────────────────────────────────────────

const colors = {
  brand: {
    navy:   "#1a2332",
    blue:   "#1a73e8",
    blueDk: "#1765cc",
    blueLt: "#e8f0fe",
    orange: "#f97316",
    red:    "#ea4335",
  },

  // Google Calendar–inspired neutrals (web app's heritage palette)
  gc: {
    surface:     "#ffffff",
    bg:          "#f8f9fa",
    border:      "#dadce0",
    borderLight: "#e8eaed",
    text1:       "#202124",
    text2:       "#3c4043",
    text3:       "#5f6368",
  },

  // Load status — paired bg/fg for badge rendering across apps.
  // Keys correspond 1:1 with the LoadStatus enum in @fleetcal/types.
  status: {
    scheduledBg:  "#f1f3f4", scheduledFg:  "#5f6368",
    dispatchedBg: "#e8f0fe", dispatchedFg: "#1558d6",
    enRouteBg:    "#fef3c7", enRouteFg:    "#92400e",
    pickedUpBg:   "#f3e8fd", pickedUpFg:   "#6b21a8",
    deliveredBg:  "#e6f4ea", deliveredFg:  "#15803d",
    cancelledBg:  "#fce8e6", cancelledFg:  "#b91c1c",
    tonuBg:       "#fef3c7", tonuFg:       "#92400e",
    problemBg:    "#fef0e6", problemFg:    "#b85c00",
  },
};

// ── Spacing (4-pt scale) ────────────────────────────────────────────────

const spacing = {
  0:    0,
  px:   1,
  0.5:  2,
  1:    4,
  1.5:  6,
  2:    8,
  2.5:  10,
  3:    12,
  3.5:  14,
  4:    16,
  5:    20,
  6:    24,
  7:    28,
  8:    32,
  10:   40,
  12:   48,
  16:   64,
  20:   80,
  24:   96,
  32:   128,
};

// ── Border radii ────────────────────────────────────────────────────────

const radii = {
  none: 0,
  xs:   2,
  sm:   4,
  md:   6,
  lg:   8,
  xl:   12,
  "2xl": 16,
  "3xl": 24,
  full: 9999,
};

// ── Typography ──────────────────────────────────────────────────────────

const typography = {
  fontFamily: {
    sans:     ["PlusJakartaSans_500Medium",   "system-ui", "sans-serif"],
    medium:   ["PlusJakartaSans_600SemiBold", "system-ui", "sans-serif"],
    semibold: ["PlusJakartaSans_700Bold",     "system-ui", "sans-serif"],
    bold:     ["PlusJakartaSans_800ExtraBold","system-ui", "sans-serif"],
  },

  fontSize: {
    xs:   12,
    sm:   13,
    base: 14,
    md:   15,
    lg:   17,
    xl:   20,
    "2xl": 24,
    "3xl": 30,
  },

  fontWeight: {
    medium:    "500",
    semibold:  "600",
    bold:      "700",
    extrabold: "800",
  },

  lineHeight: {
    tight:   1.2,
    snug:    1.35,
    normal:  1.5,
    relaxed: 1.65,
  },
};

module.exports = { colors, spacing, radii, typography };
