# @fleetcal/api

Hono server hosted on Railway. Owns business logic the frontends can't
safely run themselves: state-machine transitions, Claude API calls, external
integrations, document validation, audit logging, push dispatch.

Phase 2 ships only the foundation — `/v1/health` (public) and `/v1/whoami`
(Clerk-protected). Real endpoints land in Phase 3+.

## Local dev

```sh
cp apps/api/.env.example apps/api/.env.local
# fill in CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY

npm run dev:api
# → [api] fleetcal-api v0.1.0 listening on :8080
```

Health check:

```sh
curl http://localhost:8080/v1/health
# {"ok":true,"service":"fleetcal-api","version":"0.1.0","timestamp":"…"}
```

Authenticated test (replace `<token>` with a real Clerk session token):

```sh
curl http://localhost:8080/v1/whoami -H "Authorization: Bearer <token>"
# {"userId":"user_…","orgId":"org_…"}
```

## Production build

```sh
npm run build -w @fleetcal/api   # tsup → dist/index.js
npm run start -w @fleetcal/api   # node dist/index.js
```

`tsup` bundles workspace deps (`@fleetcal/types`) into the output so the
deployed container doesn't need to resolve npm-workspace symlinks.

## Railway setup (one-time)

1. **Create a project** at <https://railway.com/new>. Link it to the
   `mattczn/fleetcal` GitHub repo.
2. **Set the root directory** to `/` (the monorepo root, not `apps/api`).
   Railway needs the workspace root to install hoisted deps.
3. **Set the build command** to `npm install && npm run build -w @fleetcal/api`.
4. **Set the start command** to `npm run start -w @fleetcal/api`.
5. **Set environment variables** on the Railway service:
   - `NODE_ENV=production`
   - `PORT=8080` *(Railway will override with its own port; that's fine)*
   - `CLERK_SECRET_KEY` *(from Clerk dashboard — production key, not test)*
   - `CLERK_PUBLISHABLE_KEY`
   - `SUPABASE_URL=https://vgybqmvmorjhlgbsssmi.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` *(from Supabase dashboard → Settings → API)*
6. **Deploy.** Railway auto-deploys on push to `main`. The health check at
   `/v1/health` is what to wire as Railway's health-check path.

The Railway-assigned URL (`<project>.up.railway.app`) becomes the API base
URL for the frontends. Custom domain (e.g. `api.fleetcal.com`) is a later
swap once DNS is decided.

## What's NOT here yet

- Loads / stops / documents endpoints — Phase 3.
- Claude integration (assistant, parse-ratecon, parse-assets) — Phase 3.
- Motive proxy + credential storage — Phase 3.
- Push notification dispatch + the confirm-reminders cron — Phase 3.
- Audit log writer — Phase 3.
- Rate limiting / request signing — Phase N.
- Sentry / structured observability — Phase N.
