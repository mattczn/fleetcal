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

const nextConfig: NextConfig = {
  // pdfjs-dist v5 ships only .mjs files; Next.js webpack needs to transpile them
  // or its ESM interop produces "Object.defineProperty called on non-object".
  transpilePackages: ['pdfjs-dist'],
};

export default nextConfig;
