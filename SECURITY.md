# Security model

How auth, authorization, and data isolation work in FleetCal. Read this
before you create a new table, add a new auth path, or change any
Supabase grant.

The TL;DR is that there are three independent guardrails — JWT auth,
PostgreSQL grants, and RLS policies — and we need all three to stay
healthy. Any one of them missing on a new table means anyone with the
public anon key (which is shipped in the browser bundle and is therefore
publicly known) can read or write that table from a curl on their laptop.

## What's deployed (as of 2026-06-09)

**Trust chain for a dispatcher request to Supabase:**

```
Browser (signed-in dispatcher)
  │
  ├─ Clerk JS issues a JWT signed by Clerk's RSA key
  │  Template: "supabase"  (configured in Clerk dashboard)
  │  Claims:   { aud:"authenticated", role:"authenticated",
  │              org_id:"{{org.id}}", iss:"https://clerk.fleetcal.app" }
  │  Lifetime: 60s, refreshed in-memory by Clerk JS
  │
  ├─ apps/web/lib/supabase.ts attaches the JWT via the
  │  `accessToken` option on every Supabase request
  │  (REST calls + Realtime channel auth)
  │
  ├─ Supabase validates the JWT against Clerk's JWKS
  │  (Third-Party Auth provider configured in Supabase
  │   dashboard, points at clerk.fleetcal.app)
  │
  ├─ PostgreSQL receives the request as role `authenticated`
  │
  └─ RLS policy on the target table evaluates
     (auth.jwt() ->> 'org_id') = org_id  → row visible iff org matches
```

**Trust chain for the Hono API (Railway) hitting Supabase:**

```
apps/api/src/lib/supabase.ts
  │
  ├─ Uses SUPABASE_SERVICE_ROLE_KEY (server-only env var,
  │  never shipped to the browser)
  │
  └─ Service-role bypasses RLS entirely
     (Postgres setting `auth.role = 'service_role'`)
```

Same for Vercel server routes (`apps/web/lib/supabase-server.ts`) and
every Next.js API route handler. The Vercel server-side path was
previously using the anon key for historical reasons — fixed
2026-06-09.

## What every table needs

When you add a new table in `public`, do all four of these in the
migration that creates it:

```sql
CREATE TABLE my_new_thing (
  org_id  text NOT NULL,        -- 1. Almost always required for org scoping
  ...
);

ALTER TABLE my_new_thing ENABLE ROW LEVEL SECURITY;  -- 2. RLS on

CREATE POLICY "my_new_thing_org_scope" ON my_new_thing  -- 3. Scoping policy
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

REVOKE ALL ON my_new_thing FROM anon;                 -- 4. Anon gets nothing
```

The defaults for a fresh Supabase table are dangerous:

- RLS is **off**
- `anon` and `authenticated` both have **full grants** (SELECT, INSERT,
  UPDATE, DELETE)
- The Supabase API gateway (PostgREST) exposes every row to whoever
  presents the anon key

A new table without these four lines is the bug we just spent two
hours fixing for the entire schema. Don't do it again.

## When you actually want RLS off

Sometimes — rarely — a table really isn't org-scoped. Two examples
currently in the schema:

- **`cron_runs`** — per-job heartbeat written by the in-process cron in
  `apps/api/src/index.ts`. Has no org. Accessed only by the Hono API
  via service-role.
- **`api_errors`** — every 4xx/5xx the API returns, written by
  `apps/api/src/middleware/captureErrors.ts`. Has a nullable `org_id`
  (some errors fire before auth resolves). Accessed only by
  `/api/admin/errors` via service-role.

For these tables the pattern is:

```sql
ALTER TABLE api_errors ENABLE ROW LEVEL SECURITY;  -- RLS on, with no policies
REVOKE ALL ON api_errors FROM anon;                -- Anon can't see it
-- authenticated also gets nothing — there's no policy granting access
-- service-role bypasses RLS, which is the only intended caller
```

RLS-on-with-no-policies is the right call for "service-role only"
tables — it's the strictest configuration short of revoking the table
from every non-service role explicitly, and it produces clear "RLS
denied" diagnostics if something accidentally tries to read it.

## The five client-accessed tables

The browser uses Supabase directly (not via the API) for two
workflows. The tables involved are:

| Table | Why direct | Code location |
|---|---|---|
| `events` | Realtime + direct UPDATE/DELETE for performance | `useCalendarStore.ts` 1926-1972, `RealtimeSync.tsx` 44 |
| `stops` | Realtime | `RealtimeSync.tsx` 76 |
| `loads` | Realtime | `RealtimeSync.tsx` 92 |
| `load_documents` | Realtime | `RealtimeSync.tsx` 113 |
| `check_calls` | Realtime | `CheckCallsSection.tsx` 86 |

All five have RLS on with the standard `org_scope` policy. If you add
a sixth client-accessed table:

1. Add it here in the table above.
2. Make sure the policy is `FOR ALL TO authenticated`, matching this
   pattern. If you only need read access from the client, narrow to
   `FOR SELECT`.
3. Test that Realtime subscription delivers payloads — Realtime
   honors RLS the same way regular queries do, so a missing or wrong
   policy means subscribers silently see zero events.

For any other table the rule is **don't access it directly from the
browser** — route through the Hono API (Railway) or a Next.js route
handler (Vercel). The Hono API uses service-role and enforces org
scoping via `c.get('orgId')` from Clerk middleware. Don't bypass it.

## Roles in play

There are four Postgres roles to know about:

| Role | Who | What it can do |
|---|---|---|
| `service_role` | Hono API, Vercel server routes | Bypasses RLS, full grants. Server-only. |
| `authenticated` | Signed-in dispatchers (via Clerk JWT) and drivers (via Supabase Auth phone OTP) | RLS-gated by `(auth.jwt() ->> 'org_id') = org_id` |
| `anon` | Anyone with the public anon key | Should always be: no grants on tables outside the 5 client-accessed ones, RLS-blocked even on those |
| `postgres` | DB superuser | Schema migrations only |

The driver app uses Supabase Auth for phone-OTP login. Driver JWTs are
signed by Supabase (not Clerk) and lack an `org_id` claim. They will
fail any RLS policy that requires `org_id`. That's fine because the
driver app never queries `public.*` tables directly — it goes through
the Hono API, which uses service-role.

## What we don't protect against

- **Compromised dispatcher account** — If matt's Clerk credentials are
  stolen, the attacker has Curzon's full data via Clerk session.
- **Compromised service-role key** — Has full DB access. Currently
  stored in:
  - Vercel env (`SUPABASE_SERVICE_ROLE_KEY`)
  - Railway env (`SUPABASE_SERVICE_ROLE_KEY`)
  - Local `.env.local` files (gitignored)
  Rotate via Supabase dashboard → Settings → API → Reset service-role
  key; update both Vercel and Railway envs simultaneously.
- **Compromised Clerk instance secret** — Same deal for billing /
  membership reads.
- **Insider with DB superuser access** — Bypasses everything. The
  Supabase dashboard "Database → Roles" surface controls this.

## Auth-related env vars (where to find them)

| Env var | Purpose | Where it lives |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase host | Vercel, .env.local |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key for browser | Vercel, .env.local |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase key | Vercel, Railway, .env.local |
| `CLERK_PUBLISHABLE_KEY` | Public Clerk key | Vercel, Railway, .env.local |
| `CLERK_SECRET_KEY` | Server-only Clerk key for backend API | Vercel, Railway, .env.local |
| `SUPER_ADMIN_USER_IDS` | Comma-separated Clerk user IDs allowed at `/admin/*` | Vercel only |

## When to call this doc out of date

- A new client-side direct Supabase call is added — the "five tables"
  list above grows.
- We migrate off Clerk or Supabase — most of the trust chain changes.
- We add a multi-tenant feature where one user can act in multiple
  orgs simultaneously — the `org_id` claim model needs to widen.
- Anyone mentions "let's just turn off RLS for X." That's almost
  always a sign that an API endpoint is missing instead.
