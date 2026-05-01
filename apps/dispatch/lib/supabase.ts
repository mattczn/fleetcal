import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

/**
 * Supabase client matching dispatch-next's pattern: anon key + explicit
 * org_id filters on every query. Auth/scoping happens via Clerk's active
 * organization, not via JWT swap. RLS is currently disabled at the org level
 * (see project memory) — every query MUST .eq('org_id', orgId) explicitly.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    persistSession:   false,
    autoRefreshToken: false,
  },
});
