const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

// @tanstack/react-query 5.100+ ships an `exports` map that resolves to
// `build/modern/index.js`, which itself does `export * from "./types.js"`
// — but `types.js` doesn't exist (only `.d.ts`/`.d.cts`). Disabling
// package.exports resolution tells Metro to fall back to the legacy
// resolution that respects the package's `"react-native": "src/index.ts"`
// field, which works fine on Hermes.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
