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

// react-query 5.100+ ships an `exports` field that points at `./types.js`
// which isn't actually on disk — only the legacy build is. Disabling
// package-exports resolution falls back to the legacy entry that works.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
