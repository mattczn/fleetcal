# @fleetcal/database

Supabase schema, migrations, and one-off seed scripts for FleetCal. Shared
infrastructure — owned by no single app, depended on by all of them.

## Layout

```
packages/database/
├── supabase/
│   ├── config.toml          # Supabase CLI link config
│   ├── migrations/          # ordered .sql migration files
│   ├── schema.sql           # canonical schema snapshot (currently stale — see MIGRATION-FOLLOWUPS.md)
│   └── seed.ts              # one-time data migration from the legacy DB
└── package.json             # helper scripts
```

## First-time setup

```sh
# Once per machine
supabase login

# Once per checkout
cd packages/database
supabase link --project-ref vgybqmvmorjhlgbsssmi
```

After linking, the helper scripts work from anywhere in the monorepo:

```sh
npm run db:diff  -w @fleetcal/database   # show drift between local migrations and live DB
npm run db:push  -w @fleetcal/database   # apply pending migrations to live DB
npm run db:reset -w @fleetcal/database   # nuke + replay all migrations (dev only)
npm run db:dump  -w @fleetcal/database   # regenerate schema.sql from live DB
```

## Adding a migration

```sh
cd packages/database
supabase migration new <descriptive_name>
# edit the new file under supabase/migrations/
npm run db:push -w @fleetcal/database
npm run db:dump -w @fleetcal/database  # keep schema.sql in sync
```

The `db:dump` step is important — it's how `schema.sql` stays canonical.
Without it, `schema.sql` drifts from reality (which is exactly what happened
pre-monorepo and is logged in `MIGRATION-FOLLOWUPS.md`).

## What does NOT live here

- Frontend types — those live in `@fleetcal/types` and are generated from this
  schema via `supabase gen types typescript`.
- Service-role Supabase client — lives in `apps/api/src/lib/supabase.ts` (the
  API server is the only thing that should hold the service role key).
- The anon-key clients — each app initializes its own in `lib/supabase.ts`.
