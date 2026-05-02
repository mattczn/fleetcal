# Migration follow-ups

Items noticed during the standalone-repos → monorepo migration that should be
addressed but were intentionally not done at migration time to keep the migration
scope tight. None are blockers; this is the honest debt log.

## Pre-existing issues that came along for the ride

### packages/database/supabase/schema.sql is out of sync with the live database

`schema.sql` defines: assets, drivers, driver_asset_prefs, load_documents,
driver_push_tokens, events, stops, org_settings.

The live DB has additional columns and tables that aren't in `schema.sql` and
aren't in any migration file in `packages/database/supabase/migrations/`:

- `assets.motive_vehicle_id` (referenced by `DbAsset` in
  `apps/web/lib/supabase.ts`)
- `assets.sort_order` (in schema.sql but not all migrations document it)
- `events.internal_load_id`, `events.priority`, `events.event_kind`,
  `events.non_revenue_type`, `events.driver_id` (some have migrations,
  some don't)
- entire `trailers` table (referenced by `DbTrailer` in `apps/web/lib/supabase.ts`,
  not in `schema.sql` or migrations folder)
- entire `customers` table (only the `customers_short_name` migration exists,
  implying the table was added via the Supabase UI)
- `payroll_records`, `payroll_adjustments`, `load_audit_trail` tables added
  via migrations but never reflected back into `schema.sql`

Reconcile in a future session: regenerate `schema.sql` from the live database
(`supabase db dump --schema public`) so it reflects reality, and adopt a
migration-or-die policy going forward (every UI-driven schema change has a
matching `.sql` file checked in).



### apps/web — `middleware.ts` → `proxy.ts` rename (Next.js 16 deprecation)

`apps/web/middleware.ts` triggers this on dev-server boot:

> The "middleware" file convention is deprecated. Please use "proxy" instead.

Rename the file and update internal references. See
<https://nextjs.org/docs/messages/middleware-to-proxy>.

### packages/database/supabase/schema.sql — forward reference will fail

`load_documents` is declared with `REFERENCES events(id)` but appears in the file
*before* `events` is created. Running `schema.sql` against an empty database
fails on the foreign key. Either reorder the `CREATE TABLE` statements or split
into ordered migrations.

### apps/web/public/pdf.worker.min.mjs — 1.3 MB binary tracked in git

The pdf.js worker is committed as a binary blob, which bloats every clone and
forces manual updates when bumping `pdfjs-dist`. Replace with one of:

- import the worker from `node_modules/pdfjs-dist/build/pdf.worker.min.mjs`
- load from a CDN (`unpkg.com/pdfjs-dist@<version>/...`)

### apps/web emits MODULE_TYPELESS_PACKAGE_JSON warning for tailwind.config.ts

On every dev-server start, Next 16 logs:

> Module type of file:///.../apps/web/tailwind.config.ts is not specified and
> it doesn't parse as CommonJS. Reparsing as ES module because module syntax
> was detected. This incurs a performance overhead. To eliminate this warning,
> add "type": "module" to apps/web/package.json.

Performance hint, not a bug. Adding `"type": "module"` to
`apps/web/package.json` would silence it but might affect Next conventions
around how `.js`/`.cjs` files are interpreted in the rest of the project, so
left alone for now. Decide intentionally in a future session.

## TypeScript hygiene — latent errors carried over from Phase 1

Phase 1's "0 errors" verification was wrong: the regex used to count tsc
output required errors to start with a letter, but cross-package errors come
through as relative paths (`../../packages/types/...`) which start with `..`
and fell through the filter. The phase-1-complete commit contains real type
errors that were never surfaced.

Approximate counts as of phase-2-complete (apps/api is clean):

- `apps/web` — 1 (`components/calendar/EventModal.tsx:2864` — type-narrowing
  on a state-mode comparison). Unrelated to the migration.
- `apps/dispatch` — ~28 errors. Mostly `load.stops`, `editableStops`, and
  `list` flagged "possibly undefined" because Phase 1's unified `Load` made
  `stops?: Stop[]` optional while mobile callers were authored against a
  required `Stop[]`. Plus a couple of `Asset.sortOrder` undefined sites.
- `apps/driver` — ~26 errors. Same shape as dispatch.

These do not block boot — Metro/Babel ignore TS diagnostics and the apps run
fine. They should be addressed in a focused TS-cleanup pass before Phase 3
work expands the surface. Likely fixes: tighten `Load.stops` to required and
have the converter return `[]`, or audit each mobile callsite to add the
optional-chain it should already have.

## packages/types — hand-written Db* interfaces still in apps/web/lib/supabase.ts

The hand-written `DbAsset`, `DbDriver`, `DbDriverAssetPref`, `DbTrailer`,
`DbEvent`, `DbStop` interfaces in `apps/web/lib/supabase.ts` are now
superseded by the generated `Database` Row types in `@fleetcal/types`.
They've drifted in nullability and JSON-column annotations:

- `DbEvent.event_kind` is typed `string | null`; live DB and generated type
  say it's NOT NULL with default `'revenue'`.
- `DbEvent.accessorials` is typed `Accessorial[] | null`; generated says
  `Json | null`.
- `DbEvent.audit_log` is typed `LoadAuditEntry[] | null`; generated says
  `Json | null`.

Phase 2 absorbed this drift by typing the converter input as `any` (the
right pattern for a boundary converter, but a tell). Cleanup pass: delete
the `Db*` interfaces, switch all callers to the generated `*Row` aliases,
tighten the converter input back to `LoadRow`.

## packages/types — events.internal_load_id

The generated type marks `events.internal_load_id` as required on Insert,
but live DB inserts have always worked without supplying one (a default or
trigger fills it). The converter casts `as LoadInsert` to bypass. If the
column ever genuinely requires manual values, this cast hides that fact.

## packages/types — `<claude-code-hint>` injected into generated database.ts

When `supabase gen types typescript` ran during Phase 1, the output ended
with a stray `<claude-code-hint v="1" type="plugin" value="supabase@..." />`
marker on the last line. That's not valid TypeScript and triggered TS1005
errors. The phase-1-complete commit shipped with this present (the regex
bug above masked it). Removed manually in Phase 2. If a future
`supabase gen types` run re-injects it, strip the trailing line before
committing.

## Migration mechanics worth knowing

### Native build folders were not copied

`apps/dispatch/ios`, `apps/dispatch/android`, and `apps/driver/ios` were excluded
from the migration. They are regenerable from `app.json` + plugins via
`expo prebuild`. The first time anyone needs to run `expo run:ios` /
`expo run:android` from this monorepo, run `expo prebuild` in the relevant app.

### Three React versions across apps

| App           | React  |
| ------------- | ------ |
| apps/web      | 19.2.4 |
| apps/driver   | 19.2.0 |
| apps/dispatch | 19.1.0 |

npm workspaces resolves each app to its own pin (you can see the per-app
`node_modules/react` symlinks). Aligning all three to a single version reduces
hoisting friction. Low-risk bump; do it when nothing else is in flight.

### `npm audit` — 33 vulnerabilities (31 moderate, 2 high)

Reported on the first install at the monorepo root. Triage:

```
npm audit
```

Fix the highs before any dependent dep bump that pulls in adjacent packages.

### Node engine warning on `eslint-visitor-keys@5.0.1`

Cosmetic. Project ran on Node v23.6.0; that package wants
`^20.19.0 || ^22.13.0 || >=24`. Pin a Node version in `.nvmrc` to silence
this and make environments reproducible.

### npm cache had a root-owned subdirectory (resolved by user post-migration)

`~/.npm/_cacache/content-v2/sha512/08/78/` was owned by `root` from a past
`sudo npm install`, breaking fresh installs with `EEXIST`. Worked around during
the migration by using `npm install --cache /tmp/fleetcal-npm-cache`. Permanent
fix is `sudo chown -R thema:staff ~/.npm`. Once that's done, this entry can be
deleted.

## Deferred validations

### Validate driver-app assetId rendering after Clerk migration (Phase 4)

- Pre-fix, `rowToLoad` in `apps/driver/lib/api/loads.ts` constructed `Load`
  without `assetId` despite `r.asset_id` being available.
- Fix landed in `da6d114` but was not validated against running app.
- Once driver-app is back online with real data, check every UI surface
  that displays asset info on a load and confirm:
  - **(a)** values render correctly (scenario: was silently undefined), or
  - **(b)** no surface uses it (scenario: field not read).
- If (a), audit git log for any "asset shows blank" bugs that may have
  been worked around at the UI layer rather than fixed at root.

## Phase 3 — work outstanding

### Frontend mutations don't call Railway yet

The six load CRUD endpoints under `/v1/loads` exist on Railway, but
nothing in the frontends calls them. Web/dispatcher/driver still write
directly to Supabase via the legacy `appEventToDb` converter, which
writes to the deprecated event columns (`broker`, `load_num`,
`load_price`, etc.) and never creates a row in `loads`.

**Consequence:** new loads created post-2.5a-migration via the legacy
path have NO row in `loads`, so a joined-query read returns `load: null`
and the calendar would render those fields blank. This is why the
dispatch read-conversion PoC was reverted (see commit `1384a70`).

**Resolution:** wire the web app's mutations to Railway. Pattern:
- `addEvent` (revenue) → `POST /v1/loads`
- `addEvent` (non-revenue) → `POST /v1/events` *(endpoint not yet built)*
- `updateEvent` (load fields) → `PATCH /v1/loads/:id`
- `updateEvent` (event fields) → `PATCH /v1/loads/:id/events/:eventId`
- `createRelayPair` → `POST /v1/loads` with `events.length === 2`
- `saveRelayBoth` → `PATCH /v1/loads/:id` (load fields once) + `PATCH .../events/:eventId` per leg
- `removeEvent` → `DELETE /v1/loads/:id`
- `restoreEvent` → `POST /v1/loads/:id/restore` *(endpoint not yet built)*

After web is converted, dispatch and driver follow the same pattern.

### Endpoints still missing on Railway

- `POST /v1/events` — non-revenue events (maintenance, deadhead, etc.)
- `POST /v1/loads/:id/restore` — soft-delete reversal
- `PUT  /v1/loads/:id/events/:eventId/stops` — replace stops on a leg
- `POST /v1/stops/:id/checkin` — driver check-in (haversine validation)
- `POST /v1/loads/:id/documents` — document upload
- `GET  /v1/documents/:id/url` — short-lived signed URL
- `POST /v1/loads/:id/events/:eventId/status` — state-machine status transition
- Claude integration, Motive proxy, push dispatch, audit log writer

### Audit logging — PATCH endpoints don't write audit entries yet

The `loads.audit_log` jsonb column exists, but the Phase 3 PATCH
handlers don't append entries when fields change. The shared
`LoadAuditEntry` type in `packages/types/domain.ts` documents the
shape. Write the audit append in the PATCH handlers before the next
phase of work depends on a complete audit trail.

### Schema.sql is still stale (Docker-blocked)

`packages/database/supabase/schema.sql` predates the loads/events split.
The npm script `db:dump -w @fleetcal/database` runs `supabase db dump
--linked`, which requires Docker to be running locally — and Docker
isn't installed/running on this machine.

Two paths to refresh it:
1. Install Docker Desktop and run `npm run db:dump -w @fleetcal/database`.
2. Use `pg_dump` directly with the project's connection string (Supabase
   dashboard → Settings → Database → Connection string).

Until then, the canonical source of schema truth is the migrations
folder + the generated `packages/types/database.ts`. `schema.sql`
should be treated as historical reference only.

### Legacy fields in `Load` interface

`packages/types/domain.ts` `Load` carries fields (`commodity`, `weight`,
`miles`, `pickupCity`, `deliveryCity`, `dispatched`, `bolNum`, `poNum`,
`relayGroupId`, `specialInstructions`, several legacy financial fields)
that reference DB columns that are either dropped or about to be dropped
in Phase 2.5c. Keep until Phase 2.5c lands, then sweep them out in one
commit alongside the column drops.

### `dbEventToApp` / `appEventToDb` legacy converters

In `packages/types/converters.ts`. Apps still use them (frontend writes
to deprecated event columns). They're labeled "LEGACY" and will be
deleted in Phase 2.5c after the column drops. Do not write new callers.
