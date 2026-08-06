import { defineConfig } from "tsup";

/**
 * Bundle for Railway. We inline workspace deps (@fleetcal/types) so the
 * production container doesn't need to resolve npm-workspace symlinks.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  minify: false,
  // Bundle workspace packages; leave node_modules deps external.
  noExternal: ["@fleetcal/types"],
  // The signature font is a binary asset, not something tsup bundles. Copy it
  // next to the bundle so the contract PDF renders signatures in script in
  // production, not just in dev where the source tree is present.
  async onSuccess() {
    const { mkdir, copyFile } = await import("node:fs/promises");
    await mkdir("dist/assets/fonts", { recursive: true });
    await copyFile("src/assets/fonts/Signature.ttf", "dist/assets/fonts/Signature.ttf");
    await copyFile("src/assets/fonts/OFL.txt", "dist/assets/fonts/OFL.txt");
  },
});
