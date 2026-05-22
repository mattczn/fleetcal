# fleetcal

The software a small trucking company actually runs on. A dispatch calendar, a driver mobile app, a dispatcher mobile app, and the API that holds it all together.

This is a working production system, not a side project — it's used every day to move freight.

## Layout

It's a TypeScript monorepo (pnpm workspaces).

```
apps/
  web/        Next.js dispatcher app. The calendar board, load modal,
              settings, billing, maintenance, command center.
  driver/     Expo / React Native — what drivers carry in the truck.
              Schedule, load details, photo upload, POD signature,
              push notifications, offline-friendly upload queue.
  dispatch/   Expo / React Native — same idea but for dispatchers on
              the road. Smaller surface, mostly visibility.
  api/        Hono on Railway. Owns the integrations (Motive ELDs,
              Twilio SMS, Resend email, Expo Push) and the crons
              (movement sync, odometer snapshots, sweepers).

packages/
  database/   Supabase schema + generated TS types + SQL migrations.
  types/      Shared domain types (Load, Driver, Asset, etc.) used
              across web/api/mobile.
  tokens/     Shared design tokens — colors, spacing, type scale.
```

## Stack

- **Frontend:** Next.js (web), Expo / React Native (driver + dispatch)
- **Backend:** Hono on Railway, Supabase Postgres (RLS-off, JWT claims for org scoping)
- **Auth:** Clerk for both web and mobile, organizations as the tenant boundary
- **Realtime:** Supabase Realtime channels for load/event broadcasts
- **Integrations:** Motive (ELD telemetry, driving periods, odometer), Twilio (SMS), Expo Push, Resend (transactional email), Google Maps (geocoding, directions, location chooser)
- **AI:** Anthropic Claude for rate-con PDF parsing and load matching
- **Mobile delivery:** EAS Build + OTA updates

## A few things worth looking at

- [`apps/web/components/calendar/`](apps/web/components/calendar) — the dispatch calendar board. Resource view with side-by-side asset columns, drag-to-reassign, day/week toggle, smart cluster rendering for Motive movement data.
- [`apps/api/src/lib/motiveIngest.ts`](apps/api/src/lib/motiveIngest.ts) — full backfill + incremental cursor sync for Motive driving periods, rate-limit backoff, distance-string parser (because the kilometer fields are null for unidentified driving — a story).
- [`apps/api/src/routes/movements.ts`](apps/api/src/routes/movements.ts) — `/v1/movements`, `/sync`, `/verify`, `/odometer`. Includes a side-by-side Motive-vs-DB completeness check.
- [`apps/web/components/calendar/AssetDetailModal.tsx`](apps/web/components/calendar/AssetDetailModal.tsx) — combined "current location + movement history + odometer chart" view. Map on the left, scrollable history on the right, recharts line for odometer over time.
- [`apps/driver/`](apps/driver) — schedule, assigned-truck card with live location, document upload with retry queue, push registration with retry + status banner.

## Running it

Without our Clerk org, Supabase project, Motive API key, etc., you can't really run it end-to-end. The code is here to read, not to spin up.

If you've got the env, the dev loop is:

```bash
pnpm install                      # from the repo root
pnpm --filter web dev             # dispatcher web
pnpm --filter api dev             # API server
cd apps/driver && npx expo start  # driver mobile
```

Each app has its own `.env.example` showing what it needs.

## Why a monorepo

The three apps share so much (types, shared logic for load lifecycle, shared design tokens, integration clients) that splitting them was creating more friction than it saved. A single `pnpm install` and a unified TS path graph means changes to a shared type get caught at the type level across all three apps on the next build.

History note: there's a few `fleetcal-archive-*` repos still around — those are the pre-monorepo standalone apps, frozen at the point of consolidation. Everything since lives here.
