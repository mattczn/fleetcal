import * as SecureStore from "expo-secure-store";

/**
 * Token cache for Clerk Expo — persists session tokens via SecureStore so the
 * dispatcher stays signed in across app restarts.
 */
export const tokenCache = {
  async getToken(key: string) {
    try { return await SecureStore.getItemAsync(key); }
    catch { return null; }
  },
  async saveToken(key: string, token: string) {
    try { return await SecureStore.setItemAsync(key, token); }
    catch { /* swallow */ }
  },
};
