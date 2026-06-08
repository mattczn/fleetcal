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
        // Marketing landing palette (`sys.*`) — Google Workspace look.
        // Mirrors the dashboard's `--gc-*` Google Calendar palette so
        // marketing and product share one color identity. Kept
        // separate from `gc.*` so the calendar UI doesn't accidentally
        // pick these up.
        sys: {
          bg:             '#ffffff',
          surface:        '#f8f9fa',
          line:           '#dadce0',
          'line-light':   '#e8eaed',
          primary:        '#202124',
          'text-2':       '#3c4043',
          muted:          '#5f6368',
          blue:           '#1a73e8',
          'blue-light':   '#e8f0fe',
          'blue-hover':   '#1765cc',
          'blue-text':    '#1967d2',
          'blue-deep':    '#0b57d0',
          red:            '#ea4335',
          orange:         '#f97316',
          'orange-light': '#fef0e6',
          green:          '#1e8e3e',
          'green-light':  '#e6f4ea',
          purple:         '#7c3aed',
          'purple-light': '#f3e8fd',
          teal:           '#0891b2',
          'teal-light':   '#e0f7fa',
          amber:          '#f9ab00',
        },
      },
      fontFamily: {
        sans:     typography.fontFamily.sans,
        medium:   typography.fontFamily.medium,
        semibold: typography.fontFamily.semibold,
        bold:     typography.fontFamily.bold,
        // Marketing landing fonts — set via CSS variables in layout.tsx.
        // Figtree (display/headings) + Hanken Grotesk (body/UI) form the
        // Google-Workspace pairing; IBM Plex Mono stays the eyebrow/mono
        // label face.
        display: ['var(--font-figtree)', 'system-ui', 'sans-serif'],
        sys:     ['var(--font-hanken)',  'system-ui', 'sans-serif'],
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
