# @fleetcal/api

Hono server hosted on Railway. Owns business logic the frontends can't
safely run themselves: state-machine transitions, Claude API calls, external
integrations, document validation, audit logging, push dispatch.

**Live:** <https://fleetcalapi-production.up.railway.app>

## Endpoints

### Public

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health` | Returns `{ ok, service, version, timestamp }` |

### Authenticated (Clerk session token required, with active organization)

| Method | Path | Notes |
|---|---|---|
| GET    | `/v1/whoami`                          | Returns `{ userId, orgId }` |
| POST   | `/v1/loads`                           | Create a load (1 or 2 events) |
| GET    | `/v1/loads`                           | List loads with filters (`from`, `to`, `status`, `assetId`, `includeDeleted`) |
| GET    | `/v1/loads/:id`                       | Get one load (joined view, 1-2 entries) |
| PATCH  | `/v1/loads/:id`                       | Update load-level fields |
| PATCH  | `/v1/loads/:id/events/:eventId`       | Update event-level fields |
| POST   | `/v1/loads/:id/split-relay`           | Convert single-event load → relay |
| DELETE | `/v1/loads/:id`                       | Soft-delete load + its events |

Request/response shapes live in `packages/types/api.ts`.

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

Authenticated test:

```sh
curl http://localhost:8080/v1/whoami -H "Authorization: Bearer <clerk-jwt>"
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
   - `CLERK_SECRET_KEY` *(from Clerk dashboard)*
   - `CLERK_PUBLISHABLE_KEY` *(must match the publishable key the web app uses)*
   - `SUPABASE_URL=https://vgybqmvmorjhlgbsssmi.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` *(from Supabase → Settings → API → service_role key, NOT anon)*

   Don't set `PORT` — Railway injects its own.
6. **Deploy.** Railway auto-deploys on push to `main`. Health-check path:
   `/v1/health`.

## What's still missing (Phase 3 in progress)

- `POST /v1/events` — non-revenue events (no associated load)
- `POST /v1/loads/:id/restore` — soft-delete reversal
- `PUT  /v1/loads/:id/events/:eventId/stops` — replace stops on a leg
- `POST /v1/stops/:id/checkin` — driver check-in with geofence validation
- `POST /v1/loads/:id/documents` — document upload (BOL, POD, scale ticket)
- `GET  /v1/documents/:id/url` — short-lived signed URL
- `POST /v1/loads/:id/events/:eventId/status` — state-machine status transition with audit
- Claude integration (assistant, parse-ratecon, parse-assets)
- Motive proxy + credential storage
- Push notification dispatch + the confirm-reminders cron
- Audit log writer (current PATCH endpoints don't write audit_log entries yet)
- Rate limiting / request signing — Phase N
- Sentry / structured observability — Phase N

## What's not yet wired

The web/dispatcher/driver frontends do not call these endpoints yet — they
still write directly to Supabase via the legacy denormalized event columns.
Wiring them is the next milestone.
