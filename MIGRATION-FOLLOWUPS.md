# Migration follow-ups

Items noticed during the standalone-repos → monorepo migration that should be
addressed but were intentionally not done at migration time to keep the migration
scope tight. None are blockers; this is the honest debt log.

## Pre-existing issues that came along for the ride

### apps/web — `middleware.ts` → `proxy.ts` rename (Next.js 16 deprecation)

`apps/web/middleware.ts` triggers this on dev-server boot:

> The "middleware" file convention is deprecated. Please use "proxy" instead.

Rename the file and update internal references. See
<https://nextjs.org/docs/messages/middleware-to-proxy>.

### apps/web/supabase/schema.sql — forward reference will fail

`load_documents` is declared with `REFERENCES events(id)` but appears in the file
*before* `events` is created. Running `schema.sql` against an empty database
fails on the foreign key. Either reorder the `CREATE TABLE` statements or split
into ordered migrations.

### apps/web/public/pdf.worker.min.mjs — 1.3 MB binary tracked in git

The pdf.js worker is committed as a binary blob, which bloats every clone and
forces manual updates when bumping `pdfjs-dist`. Replace with one of:

- import the worker from `node_modules/pdfjs-dist/build/pdf.worker.min.mjs`
- load from a CDN (`unpkg.com/pdfjs-dist@<version>/...`)

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
