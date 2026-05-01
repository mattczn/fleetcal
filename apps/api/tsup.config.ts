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
});
