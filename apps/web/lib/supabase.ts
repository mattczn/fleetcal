import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Supabase anon-key client (browser-side) ────────────────────────────────
//
// Used for the few flows that still hit Supabase directly from the browser:
//   • Realtime subscriptions (RealtimeSync.tsx, CheckCallsSection.tsx)
//     on events / stops / loads / load_documents / check_calls
//   • Direct UPDATE/DELETE on `events` from useCalendarStore
//
// Auth model (Phase 2 of the RLS lockdown — landed 2026-06-09):
//
//   The `accessToken` callback below runs on every Supabase request and
//   returns a Clerk-issued JWT signed by Clerk's RSA keys. Supabase is
//   configured (dashboard → Auth → Third-Party Auth → Clerk, domain
//   `clerk.fleetcal.app`) to validate JWTs against Clerk's JWKS endpoint
//   at https://clerk.fleetcal.app/.well-known/jwks.json, so any Clerk-
//   issued token gets `role: authenticated` Postgres-side.
//
//   The JWT comes from a Clerk JWT template named "supabase" which
//   includes the `org_id` claim ({{org.id}} in Clerk's template syntax).
//   RLS policies on the 5 client-accessed tables read this via
//   `(auth.jwt() ->> 'org_id') = org_id` to scope reads/writes to the
//   active org. Without a valid JWT, the policies block everything.
//
//   The token is short-lived (~60s default) but Clerk caches it in-
//   memory between calls until ~10s before expiry, so the cost of
//   getToken() is one fetch per minute, not per request.
//
//   Failure modes:
//   • No Clerk session (signed-out): callback returns null → Supabase
//     uses just the anon key. RLS denies. User shouldn't be here anyway.
//   • Clerk not yet loaded (initial paint race): callback returns null,
//     same outcome. Components subscribe to useUser/useOrganization so
//     they re-render once Clerk hydrates.
//   • Template misconfigured (e.g. typo, missing org_id claim): JWT is
//     valid but RLS denies. Visible in Supabase logs.

declare global {
  interface Window {
    Clerk?: {
      session?: {
        getToken: (opts?: { template?: string }) => Promise<string | null>;
      };
    };
  }
}

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
    }
    _client = createClient(url, key, {
      accessToken: async () => {
        // SSR safety — window doesn't exist on the server during
        // Next.js's initial render. The callback is still invoked
        // server-side for any code that imports getSupabase from a
        // server context (shouldn't happen, but defensive).
        if (typeof window === 'undefined') return null;

        const clerk = window.Clerk;
        const session = clerk?.session;
        if (!session) return null;

        try {
          // Template 'supabase' is configured in the Clerk dashboard
          // with claims:
          //   aud: "authenticated"
          //   role: "authenticated"
          //   org_id: "{{org.id}}"
          //   iss: "https://clerk.fleetcal.app"
          // RS256 signing → Supabase validates via JWKS.
          return await session.getToken({ template: 'supabase' });
        } catch (err) {
          // Token issuance can fail if the template isn't deployed
          // yet, or in transient Clerk outages. We return null so
          // Supabase still sends the request with just the anon key
          // — RLS will block it, but the call shape is preserved.
          console.warn('[supabase] Clerk token fetch failed; falling back to anon:', err);
          return null;
        }
      },
    });
  }
  return _client;
}
