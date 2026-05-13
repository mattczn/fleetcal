# Org permissions — Clerk Dashboard setup

This is a one-time configuration in the **Clerk dashboard** (not in
code) that activates the role/capability system shipped in
`@fleetcal/types/permissions`. The code is already deployed; without
this dashboard work it falls back to "everyone is a dispatcher" (no
destructive permissions, no org settings, no member management).

You need:
- Access to the Clerk dashboard for the FleetCal Clerk application
- 10 minutes
- Production AND development instances if they're separate

## 1. Enable Organizations + custom roles

Probably already done — but verify under **Organizations → Settings**:

- **Organizations enabled** — ✓
- **Maximum allowed memberships per user** — whatever you want
- **Custom roles** — toggle ON (under "Roles & permissions")

## 2. Define the four roles

Under **Organizations → Roles & permissions → Roles**, you should
have these four. The slug on the left side of the colon (`org:`) is
what gets compared in code — make them match exactly.

| Display name   | Key (slug)         | Notes                                                                 |
| -------------- | ------------------ | --------------------------------------------------------------------- |
| Owner          | `org:owner`        | Clerk's built-in creator role. Already exists; rename "Admin" to this if needed. |
| Admin          | `org:admin`        | Custom. Full access except org delete/transfer.                       |
| Dispatcher     | `org:dispatcher`   | Custom. Default operations role.                                      |
| Maintenance    | `org:maintenance`  | Custom. Read calendar + Maintenance/Fuel only.                        |

Clerk requires every role to have at least one Clerk-side permission.
Use these (purely for Clerk's invitation/admin model — they don't
affect FleetCal capability checks, which are role-name-based):

- **Owner / Admin**: `org:sys_memberships:manage`,
  `org:sys_memberships:read`, `org:sys_domains:manage`,
  `org:sys_domains:read`, `org:sys_profile:manage`
- **Dispatcher / Maintenance**: `org:sys_memberships:read`

Set the **default role for new members** to `org:dispatcher`.

## 3. Update the session JWT template

Under **JWT templates → Session**, edit the default session token to
include the role. Replace the entire template body with:

```json
{
  "role": "authenticated",
  "org_id":   "{{org.id}}",
  "org_role": "{{org_membership.role}}"
}
```

Notes:

- `role: "authenticated"` is **Supabase**'s expected role string —
  required if you ever turn on Supabase RLS. Keep it.
- `org_id` is the org we scope every query by. Required.
- `org_role` is the slug like `org:dispatcher`. Our API middleware
  strips the `org:` prefix and parses into the typed role.

Save the template. Users will pick up the new claim on their next
token refresh (~60s).

## 4. Backfill existing members

For any existing memberships that are currently `org:admin` (Clerk's
default), decide who should be **Owner** vs **Admin** vs **Dispatcher**
and assign accordingly. The API treats users with no recognized role
as Dispatcher (the safe default), so anyone who slips through still
has working day-to-day access.

## 5. Smoke test

1. Hard refresh the dispatch web app.
2. Open the browser's network tab and inspect a request to the API.
3. The Bearer token's payload (decode at jwt.io) should now include
   `org_id` AND `org_role`.
4. As a Dispatcher, you should be unable to hit destructive endpoints
   once Phase 2 ships. Until then, the UI is unchanged.

## What happens if I skip this?

Until the JWT template includes `org_role`, the API middleware sets
the role to `undefined`, which `can()` treats as denied for every
capability. To prevent locking the app down for users who haven't yet
refreshed their token after a deploy, the parser falls back:

- Missing role → treated as Dispatcher (full operational access,
  no destructive deletes, no payroll/settings).
- Clerk's legacy `org:admin` → treated as our Admin.
- Clerk's legacy `org:member` → treated as Dispatcher.

So the worst-case behavior pre-setup is "everyone is a Dispatcher",
not "everyone is locked out." Phase 2 then enforces the matrix.
