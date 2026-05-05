/**
 * One-off generator for the DispatchGo app icons.
 *
 *   icon.png         — iOS (1024×1024, opaque blue background, white truck)
 *   adaptive-icon.png — Android adaptive foreground (1024×1024, transparent
 *                       background, truck centered inside the 66% safe zone)
 *   splash-icon.png  — splash screen logo (square white truck on the same
 *                       blue, slightly tighter so it fills the viewport mark)
 *
 * Run:  node apps/dispatch/scripts/generate-icons.mjs
 *
 * Why a script and not just a static PNG: this lets us tweak the brand
 * mark in one place and regenerate all three sizes consistently.
 */
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "..", "assets");

const BRAND_BLUE  = "#1a73e8";
const BRAND_BLUE_2 = "#1558d6"; // darker, for subtle gradient
const WHITE       = "#ffffff";

/**
 * Lucide-style truck path inside a 24×24 viewBox, scaled up via SVG.
 * The two wheel centers sit at y=18 (which becomes the visual baseline)
 * and the cab top at y=4 — a 14-unit-tall composition we can re-center
 * cleanly.
 */
function truckPaths(stroke, strokeWidth = 1.6) {
  return `
    <g fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7"  cy="18" r="2" />
    </g>
  `;
}

/**
 * Full app-icon SVG. Renders a 1024×1024 square with a slight blue
 * radial highlight so the icon doesn't read as a flat block, and a
 * centered truck mark in white.
 */
function appIconSvg(stroke = WHITE) {
  // The truck composition is 24×14 (cols 0–24, rows 4–18). We center it
  // and scale to 60% of the canvas — leaves room for iOS rounded-corner
  // mask and the Android safe-zone overlap.
  const scale     = 26;          // 24*26 = 624 wide, 14*26 = 364 tall
  const truckW    = 24 * scale;
  const truckH    = 14 * scale;
  const x         = (1024 - truckW) / 2;
  const y         = (1024 - truckH) / 2 + 8; // optical nudge: wheels feel heavy at the bottom
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <radialGradient id="bg" cx="35%" cy="30%" r="80%">
          <stop offset="0%"  stop-color="${BRAND_BLUE}" />
          <stop offset="100%" stop-color="${BRAND_BLUE_2}" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" fill="url(#bg)" />
      <g transform="translate(${x} ${y}) scale(${scale})">
        ${truckPaths(stroke, 1.6)}
      </g>
    </svg>
  `;
}

/**
 * Android adaptive-icon foreground. The OS may mask this to a circle,
 * squircle, or rounded square, so we keep the truck inside the inner
 * 66% safe zone (Google's published rule of thumb). No background —
 * adaptive-icon backgroundColor is "#1a73e8" in app.json and gets
 * composited by the launcher.
 */
function adaptiveIconSvg(stroke = WHITE) {
  // 66% of 1024 = 676 px safe-zone diameter. Truck composition is
  // 24×14; scale so the wider dimension fits inside the safe square.
  const scale     = 22;          // 24*22 = 528 wide, 14*22 = 308 tall
  const truckW    = 24 * scale;
  const truckH    = 14 * scale;
  const x         = (1024 - truckW) / 2;
  const y         = (1024 - truckH) / 2 + 8;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <g transform="translate(${x} ${y}) scale(${scale})">
        ${truckPaths(stroke, 1.4)}
      </g>
    </svg>
  `;
}

async function writePng(svg, outName) {
  const out = resolve(ASSETS, outName);
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`✓ wrote ${outName}`);
}

await writePng(appIconSvg(),       "icon.png");
await writePng(adaptiveIconSvg(),  "adaptive-icon.png");
await writePng(appIconSvg(),       "splash-icon.png");
console.log("done");
