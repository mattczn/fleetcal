import type { Config } from "tailwindcss";
import { colors, typography } from "@fleetcal/tokens";

/**
 * Tailwind v4 picks this up via the `@config "../tailwind.config.ts"` directive
 * in app/globals.css. We extend rather than replace because the existing CSS
 * variables in :root still drive a lot of the calendar/ratecon UI.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand:  colors.brand,
        gc:     colors.gc,
        status: colors.status,
      },
      fontFamily: {
        sans:     typography.fontFamily.sans,
        medium:   typography.fontFamily.medium,
        semibold: typography.fontFamily.semibold,
        bold:     typography.fontFamily.bold,
      },
    },
  },
  plugins: [],
};

export default config;
