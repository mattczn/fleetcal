// react-native-url-polyfill was needed on pre-0.72 React Native. RN 0.83
// (this app) ships URL + URLSearchParams natively, so the polyfill is dead
// weight that pulled in a broken transitive-dep chain (buffer / punycode /
// webidl-conversions / whatwg-url-without-unicode). Don't add it back.
import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";

// Replace with your actual Supabase project URL and anon key
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
