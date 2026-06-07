# Clerk dev → prod migration: Curzon Trucking

This playbook covers transitioning FleetCal's Clerk auth from **Development** to **Production**, including remapping Curzon Trucking's `org_id` (and every team member's `user_id`) across **37 tables + JSONB audit columns** without losing or orphaning any data.

> **TL;DR:** Clerk dev and prod are effectively separate instances — they hand out different `user_xxx` and `org_xxx` identifiers. Our DB uses `org_id` as the tenant key everywhere, so the cutover is "set up prod Clerk → get new IDs → run remap script → switch env vars."

---

## Phase 1 — Set up Clerk production (no DB changes)

Do all of this in the Clerk dashboard BEFORE touching the Supabase DB.

1. **Activate Production instance.** Clerk → top-left instance switcher → "Activate production." This requires a production-tier Clerk plan if you're not already on one.

2. **Configure the production domain.** Clerk requires a verified custom domain for production (the `*.clerk.accounts.dev` shared domain is dev-only). Suggested: `clerk.fleetcal.app`.
   - Add the DNS records Clerk shows you.
   - Wait for verification (usually minutes).

3. **Mirror dev configuration.** In the prod instance, replicate:
   - Same social/email login providers
   - Same user metadata fields
   - Same organization roles (`admin`, `member`, etc.)
   - Same branding (logo, theme)
   - Same JWT template if you customized it

4. **Create the Curzon org in prod.**
   - Organizations → Create organization → name "Curzon Trucking" (match the dev display name)
   - Note the **new prod org_id** — you'll need it for the SQL script. It will be a fresh `org_xxx` value.

5. **Invite every team member to the prod Curzon org.**
   - Each member signs up in prod (their `user_id` will differ from dev).
   - Note the **dev → prod user_id mapping** for every member. Record it in a CSV like:
     ```
     name,email,dev_user_id,prod_user_id
     Matt Curzon,curzondispatch2@gmail.com,user_xxxxxxx,user_yyyyyyy
     ```

   This is the dependency for the user-id remap step. Without it the audit log / created_by / uploaded_by columns end up pointing at user IDs that no longer exist.

6. **(Optional) Update OAuth redirect URLs.** If you use any third-party OAuth (Google, etc.), point them at the production Clerk domain.

---

## Phase 2 — Pre-flight checks

Don't start the remap until all of these pass:

- [ ] You have the new prod `org_id` for Curzon written down
- [ ] You have a `dev_user_id → prod_user_id` map for every member who has interacted with data (created loads, uploaded documents, made check-calls, made edits in audit log)
- [ ] You've taken a **Supabase backup** of the project (Settings → Backups → "Create backup now"). This is your one-shot rollback path.
- [ ] You've updated `apps/api/.env.production` and `apps/web/.env.production` (or your hosting provider's env vars) with the new prod Clerk publishable + secret keys (Clerk → API Keys → Production)
- [ ] You've already deployed the env-var change to a staging environment if you have one, OR you've scheduled a short maintenance window (~30 min) for the cutover

---

## Phase 3 — Remap (the SQL script)

Use `scripts/clerk-prod-remap.sql` (in this repo). The script is a parameterized template — at the top there's a `DO $$ DECLARE` block with `v_old_org_id`, `v_new_org_id`, and a hardcoded user-id mapping CTE. Fill in the values, then run **inside a transaction** in the Supabase SQL editor.

The script:

1. **Wraps everything in `BEGIN; ... COMMIT;`** so you can rollback at any step if something looks wrong. Use `ROLLBACK;` if a verification query returns unexpected rows.

2. **Updates `org_id` on all 37 tables.** A single `UPDATE table SET org_id = v_new WHERE org_id = v_old` per table. The UNIQUE constraints (`loads(org_id, internal_load_id)`, `payroll_records(org_id, driver_name, week_start)`, etc.) are stable across the rename — none of the *other* keyed columns change, so the constraints don't fire.

3. **Updates Clerk `user_id` columns on 11 surfaces.** Uses a temp mapping table built from the CTE so a single `UPDATE table SET col = m.prod_user_id FROM map m WHERE col = m.dev_user_id` handles each.

4. **Rewrites JSONB audit log nested IDs.** For `loads.audit_log`, `loads.internal_notes`, `events.audit_log`, `events.driver_history`. Uses `jsonb_path_ops` to find `userId` / `authorId` keys and replace via the mapping table.

5. **Re-runs verification queries at the end:**
   - "Any row left with the old org_id?" → must return 0
   - "Any audit_log entry referencing a dev user_id?" → must return 0
   - "Total row counts pre/post" — sanity check that nothing got duplicated or dropped

If verification passes → `COMMIT;`. If anything looks off → `ROLLBACK;` and investigate before retrying.

### What the script does NOT touch

- **Internal driver IDs (bigint).** Columns like `confirmed_by_driver_id` reference internal `drivers.id` rows, not Clerk users. Drivers stay attached to the Curzon org row via FK, so they migrate "for free" when the org_id swaps.

- **Display name fields.** `created_by_name`, `completed_by_name`, etc. are denormalized display strings — they remain correct because the human names don't change between Clerk instances.

- **Internal record IDs.** Every table's primary key (`id` UUIDs / bigints) stays the same. Only the `org_id` foreign-key and Clerk user-id text columns change.

- **External integrations.** Motive IDs, Stripe customer IDs (none yet), Resend message IDs — none of these depend on Clerk identifiers.

---

## Phase 4 — Cutover sequence

When you're ready to actually flip:

1. **Deploy the env var change.** Push the new Clerk prod publishable + secret to your hosting provider. Don't restart the app yet.

2. **Put the app in maintenance mode.** Either via your hosting provider's feature, or temporarily comment out an HTML route so users see a "Back in 30 min" page.

3. **Run the remap SQL.** Paste `clerk-prod-remap.sql` into the Supabase SQL editor with values filled in. Step through:
   - Verify the `v_old_org_id` row exists before the UPDATE block
   - Run the UPDATE block
   - Run the verification block
   - `COMMIT` (or `ROLLBACK` if anything looks off)

4. **Restart the app** with the new Clerk env vars.

5. **Smoke-test as Matt:**
   - Log in with Matt's Clerk credentials (prod)
   - The org switcher shows Curzon Trucking
   - Load the calendar — every existing load is visible
   - Open one load → audit log shows "Matt edited …" attribution intact (the user_id remap worked)
   - Upload a document → uploaded_by field gets the new prod user_id (verifying middleware is using the right tokens)

6. **Smoke-test as a second team member.** Confirm they can also log in and see Curzon's data.

7. **Take maintenance mode off.**

---

## Phase 5 — Post-migration cleanup

- **Update `MEMORY.md`** with the new prod org_id (replace the old `org_3Cgzom31hVxbq6WR3FjVTbL6K3t` reference at the bottom).
- **Update `scripts/import-old-work-orders.sql`** if you ever plan to re-run it. The hardcoded org_id at line 26 needs to be the new prod value. If you're never re-running it, leave a comment marking it dev-only.
- **Update JSDoc comments** in `apps/api/src/scripts/import-alvys-documents.ts` and the 5 other scripts. These are doc strings, so they don't break anything, but they're misleading if left pointing at the dev id.
- **Revoke dev Clerk keys** from any production-adjacent surface. Keep them around for local development only.

---

## Risk callouts

- **Storage paths.** Document blobs in Supabase Storage use paths like `org_{org_id}/load_{id}/foo.pdf`. The SQL remap renames the **column** but does NOT rename the **storage path prefixes**. After cutover, existing file URLs still point at `org_3Cgzom31...` paths and continue working — the bucket policies are RLS-disabled, so the API can still fetch them. Keep this in mind if you ever migrate to a stricter bucket policy.

- **In-flight requests.** The 30-min maintenance window assumes nobody is editing data mid-migration. If a dispatcher submits a load update after the env-var flip but before the SQL runs, that update goes to the new prod org_id (which doesn't exist yet in the DB) and silently fails. Maintenance mode prevents this.

- **Driver mobile app.** Drivers authenticate against the dev Clerk JWT today. After cutover their tokens are invalid; they'll get a login prompt. Pre-stage a "we've upgraded — sign in again" notification if you can.

- **Realtime subscriptions.** Supabase realtime filters on `org_id` — open browser tabs will stop receiving events for the old org_id mid-migration. Forcing a refresh after cutover resolves this.

- **Rollback.** If anything goes wrong during the SQL block, `ROLLBACK;` undoes everything inside the transaction. If you've already `COMMIT;`'d AND the env vars are switched AND something is broken, restore from the Supabase backup you took in Phase 2 — this puts you back where you started, dev Clerk and all.
