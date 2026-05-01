/**
 * Type definitions for @fleetcal/tokens.
 *
 * The runtime values live in index.js (CommonJS so Tailwind/NativeWind configs
 * can `require()` them from raw Node). These declarations expose strongly
 * typed shapes for TypeScript consumers.
 */

export declare const colors: {
  readonly brand: {
    readonly navy:   "#1a2332";
    readonly blue:   "#1a73e8";
    readonly blueDk: "#1765cc";
    readonly blueLt: "#e8f0fe";
    readonly orange: "#f97316";
    readonly red:    "#ea4335";
  };
  readonly gc: {
    readonly surface:     "#ffffff";
    readonly bg:          "#f8f9fa";
    readonly border:      "#dadce0";
    readonly borderLight: "#e8eaed";
    readonly text1:       "#202124";
    readonly text2:       "#3c4043";
    readonly text3:       "#5f6368";
  };
  readonly status: {
    readonly scheduledBg:  "#f1f3f4"; readonly scheduledFg:  "#5f6368";
    readonly dispatchedBg: "#e8f0fe"; readonly dispatchedFg: "#1558d6";
    readonly enRouteBg:    "#fef3c7"; readonly enRouteFg:    "#92400e";
    readonly pickedUpBg:   "#f3e8fd"; readonly pickedUpFg:   "#6b21a8";
    readonly deliveredBg:  "#e6f4ea"; readonly deliveredFg:  "#15803d";
    readonly cancelledBg:  "#fce8e6"; readonly cancelledFg:  "#b91c1c";
    readonly tonuBg:       "#fef3c7"; readonly tonuFg:       "#92400e";
    readonly problemBg:    "#fef0e6"; readonly problemFg:    "#b85c00";
  };
};

export declare const spacing: {
  readonly [k: string]: number;
};

export declare const radii: {
  readonly [k: string]: number;
};

export declare const typography: {
  readonly fontFamily: {
    readonly sans:     readonly string[];
    readonly medium:   readonly string[];
    readonly semibold: readonly string[];
    readonly bold:     readonly string[];
  };
  readonly fontSize: {
    readonly [k: string]: number;
  };
  readonly fontWeight: {
    readonly medium:    "500";
    readonly semibold:  "600";
    readonly bold:      "700";
    readonly extrabold: "800";
  };
  readonly lineHeight: {
    readonly tight:   number;
    readonly snug:    number;
    readonly normal:  number;
    readonly relaxed: number;
  };
};

export type Colors     = typeof colors;
export type Spacing    = typeof spacing;
export type Radii      = typeof radii;
export type Typography = typeof typography;
