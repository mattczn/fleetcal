import Constants from "expo-constants";
// Fallback: read directly from the bundled app.json. Belt-and-suspenders for
// the case where Constants.expoConfig is stale after an app.json edit.
import appJson from "../app.json";

interface Extra {
  clerkPublishableKey: string;
  supabaseUrl:         string;
  supabaseAnonKey:     string;
  googleMapsKey?:      string;
  dispatchApiUrl?:     string;
}

interface ConstantsManifest { extra?: Partial<Extra> }
const constantsExtra =
  (Constants.expoConfig as ConstantsManifest | null)?.extra ??
  ((Constants as unknown as { manifest2?: { extra?: Partial<Extra> } }).manifest2?.extra) ??
  ((Constants as unknown as { manifest?: { extra?: Partial<Extra> } }).manifest?.extra) ??
  {};

const bundledExtra = (appJson as unknown as { expo: { extra?: Partial<Extra> } }).expo.extra ?? {};

// Constants takes precedence (in case of runtime overrides), bundled fills in gaps.
const extra: Partial<Extra> = { ...bundledExtra, ...constantsExtra };

if (!extra.clerkPublishableKey || !extra.supabaseUrl || !extra.supabaseAnonKey) {
  throw new Error(
    "Missing required values in app.json `extra` (clerkPublishableKey, supabaseUrl, supabaseAnonKey).",
  );
}

if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log("[env]", {
    fromConstants: Object.keys(constantsExtra),
    fromBundle:    Object.keys(bundledExtra),
    merged:        Object.keys(extra),
    hasGoogleMapsKey: !!extra.googleMapsKey,
  });
}

export const env: Extra = extra as Extra;
