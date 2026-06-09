import { createClient } from '@supabase/supabase-js';

/**
 * Server-only Supabase client.
 *
 * Uses the SERVICE_ROLE key — bypasses RLS, has full access to every
 * table. ONLY import from server-side files (route handlers,
 * server components). Importing this from a client component will
 * leak the service-role key into the browser bundle.
 *
 * `auth: { persistSession: false }` disables the cookie/localStorage
 * session machinery the Supabase SDK normally maintains — on the
 * server we want a stateless client that uses the static key per
 * request, not a session.
 */
export function getSupabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
