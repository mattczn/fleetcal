import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Supabase anon-key client ──────────────────────────────────────────────────
//
// Web is now mostly on Railway; this client only backs the few reads that
// haven't been migrated yet (fetchBrokerLoads, payroll, saved_locations,
// org_settings). Once those move over, drop the anon key from the browser
// entirely.

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
    }
    _client = createClient(url, key);
  }
  return _client;
}
