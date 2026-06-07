import * as SecureStore from "expo-secure-store";
import { env } from "./env";

/**
 * Token cache for Clerk Expo — persists session tokens via SecureStore so the
 * dispatcher stays signed in across app restarts.
 *
 * Namespaced by the publishable key's instance prefix (`pk_test_xxxx` /
 * `pk_live_xxxx`). When the publishable key changes (e.g. dev → prod
 * cutover), the new ClerkProvider asks for keys under a NEW namespace, so
 * the stale dev-instance JWT in the keychain is invisible — Clerk gets
 * cache-miss → null → no token → loads cleanly into the signed-out state.
 *
 * Without this, an in-place update from dev-key to prod-key hangs on
 * ClerkLoaded forever: Clerk hands the old dev JWT to the prod backend,
 * which can't validate it (different signing keys, different user ids).
 */
function instancePrefix(pk: string): string {
  // First 16 chars of the publishable key uniquely identify the Clerk
  // instance (e.g. "pk_live_Y2xlcmsu" vs "pk_test_d2VsbC1tYXJsaW4"). Short
  // enough to keep keychain keys readable, distinct enough that dev/prod
  // never collide. Using a hash would be overkill — the publishable key
  // is, by definition, not a secret.
  return pk.slice(0, 16);
}

const prefix = instancePrefix(env.clerkPublishableKey);

export const tokenCache = {
  async getToken(key: string) {
    try { return await SecureStore.getItemAsync(`${prefix}__${key}`); }
    catch { return null; }
  },
  async saveToken(key: string, token: string) {
    try { return await SecureStore.setItemAsync(`${prefix}__${key}`, token); }
    catch { /* swallow */ }
  },
};
