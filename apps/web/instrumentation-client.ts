/**
 * Client-side instrumentation — runs before any React code on the
 * client. Next.js 16 picks this file up automatically.
 *
 * Currently used to silence one specific React 19 dev-mode warning
 * we can't avoid: the "Encountered a script tag while rendering React
 * component" warning emitted whenever a <script> element appears in
 * the React tree. We need that script tag for the FOUC-prevention
 * theme init in app/layout.tsx, and React 19 fires the warning even
 * for external <script src> elements in <head>. The script actually
 * does execute on first paint (which is the whole point — preventing
 * a flash of the wrong palette), so the warning is misleading noise.
 *
 * If/when React 19 gets a documented way to opt into "yes I really
 * want this script tag in the tree," remove this filter.
 */

if (process.env.NODE_ENV !== "production") {
  const SUPPRESSED_PATTERNS = [
    "Encountered a script tag while rendering React component",
  ];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && SUPPRESSED_PATTERNS.some((p) => first.includes(p))) {
      return;
    }
    origError.apply(console, args as []);
  };
}

export {};
