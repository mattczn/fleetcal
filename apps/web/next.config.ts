import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

// System env vars (e.g. blanked by Claude Code CLI) override .env.local.
// Re-apply any blank vars from .env.local so API routes have the real values.
try {
  const lines = fs.readFileSync(path.resolve(".env.local"), "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]+)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* file may not exist in CI */ }

// Security headers applied to every response from this Next.js app.
//
// What each one does:
//   - Strict-Transport-Security: forces browsers to use HTTPS for a year
//     and includes subdomains. Prevents downgrade / SSL-strip attacks.
//   - X-Frame-Options: DENY — nothing can embed FleetCal in an iframe.
//     Stops clickjacking. We don't expose any surfaces that NEED to be
//     framed (Stripe + Clerk iframes are inside OUR pages, not vice versa).
//   - X-Content-Type-Options: nosniff — browsers must honor declared
//     MIME types instead of guessing. Defends against MIME-confusion XSS.
//   - Referrer-Policy: strict-origin-when-cross-origin — outbound link
//     clicks only leak the bare origin to third parties, never the full
//     URL (which could contain ?plan=growth, doc IDs, etc.).
//   - Permissions-Policy: opt out of browser APIs we never ask for. If
//     a future XSS payload tried to read geolocation or use the mic,
//     the browser refuses regardless.
//   - X-DNS-Prefetch-Control: on — minor perf win, prefetches DNS for
//     cross-origin links the user might click.
//
// NOT setting CSP here yet. CSP needs careful auditing of every
// third-party origin we load (Clerk widgets, Stripe checkout, Google
// fonts, Vercel preview cookies, etc.). Doing it wrong silently breaks
// sign-in or billing. Track as a follow-up to set in Report-Only mode
// first, observe violations for a week, then enforce.
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Frame-Options',           value: 'DENY' },
  { key: 'X-Content-Type-Options',    value: 'nosniff' },
  { key: 'Referrer-Policy',           value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',        value: 'geolocation=(), microphone=(), camera=(), payment=(self), usb=()' },
  { key: 'X-DNS-Prefetch-Control',    value: 'on' },
];

const nextConfig: NextConfig = {
  // pdfjs-dist v5 ships only .mjs files; Next.js webpack needs to transpile them
  // or its ESM interop produces "Object.defineProperty called on non-object".
  // @fleetcal/* are workspace TS packages; Next has to compile their source.
  transpilePackages: ['pdfjs-dist', '@fleetcal/tokens', '@fleetcal/types'],

  // Apply security headers to every route. /:path* matches everything
  // including the root, so marketing pages, /sign-in, /calendar, etc.
  // all pick them up. No source-route exclusions — these headers are
  // universally safe.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
