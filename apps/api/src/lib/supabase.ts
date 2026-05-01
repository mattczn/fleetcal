/**
 * Service-role Supabase client — bypasses RLS. Only the API server holds
 * this key; never expose it to a frontend.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@fleetcal/types";
import { env } from "./env.js";

export const supabase = createClient<Database>(
  env.supabaseUrl,
  env.supabaseServiceRoleKey,
  {
    auth: {
      // Server-side: no session persistence, no auto-refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);
