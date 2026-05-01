const { withEntitlementsPlist } = require("@expo/config-plugins");

/**
 * expo-apple-authentication is installed as a Clerk peer dep but we don't
 * use Apple sign-in. Its config plugin auto-adds the `applesignin`
 * entitlement, which Personal Teams can't sign with. Strip it after
 * auto-apply.
 */
module.exports = function stripAppleSignIn(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults["com.apple.developer.applesignin"];
    return cfg;
  });
};
