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
        // Marketing landing palette (`sys.*`) — mirrors systematica-site
        // so the / page can use the same typography + color blocks. Kept
        // separate from `gc.*` (dashboard tokens) so the calendar UI
        // doesn't accidentally pick these up.
        sys: {
          bg:             '#ffffff',
          surface:        '#F5F7FF',
          line:           '#E0E5F2',
          primary:        '#111827',
          muted:          '#6B7280',
          blue:           '#1B5EE4',
          'blue-light':   '#EEF3FD',
          'blue-hover':   '#1549C4',
          orange:         '#F47316',
          'orange-light': '#FFF4EB',
          green:          '#16A34A',
          'green-light':  '#F0FDF4',
          purple:         '#7C3AED',
          'purple-light': '#F5F3FF',
          teal:           '#0891B2',
          'teal-light':   '#ECFEFF',
          amber:          '#D97706',
          'amber-light':  '#FFFBEB',
        },
      },
      fontFamily: {
        sans:     typography.fontFamily.sans,
        medium:   typography.fontFamily.medium,
        semibold: typography.fontFamily.semibold,
        bold:     typography.fontFamily.bold,
        // Marketing landing fonts — set via CSS variables in layout.tsx.
        display: ['var(--font-dm-serif)', 'Georgia', 'serif'],
        sys:     ['var(--font-dm-sans)',  'system-ui', 'sans-serif'],
        mono:    ['var(--font-ibm-mono)', '"Courier New"', 'monospace'],
      },
      letterSpacing: {
        widest: '0.35em',
      },
    },
  },
  plugins: [],
};

export default config;
