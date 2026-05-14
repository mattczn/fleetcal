# Testing role-based permissions

Walks you through inviting a test teammate and verifying that
Dispatcher / Maintenance roles see the trimmed app the way the
permission matrix in `packages/types/permissions.ts` says they should.

You need:

- A second email you control (Gmail aliases work — `you+test@…`)
- An incognito / private browser window for the test user
- ~5 minutes

## 1. Invite the test member

In FleetCal, **Settings → Members**. (The link only appears for Owner
/ Admin — if you don't see it, your role isn't high enough.)

In the embedded Clerk panel:

1. Switch to the **Invitations** tab
2. Click **Invite member**
3. Enter the test email
4. Pick a role: **Member** (Clerk's default — maps to our Dispatcher)
   - If you have custom roles like `org:maintenance` configured in
     the Clerk dashboard, you'll see them in the role picker
5. Send the invite

## 2. Accept the invite

1. Open the invite email in your test inbox
2. Click the link
3. Sign up / sign in as the test user
4. Accept the organization invitation

## 3. Verify the Dispatcher experience

Open `https://your-fleetcal-domain` (or `http://localhost:3000` if
testing locally) in an **incognito window** and sign in as the test
user. You should see:

| Surface | Expected for Dispatcher (`org:member`) |
| --- | --- |
| Top nav (More menu on Calendar) | Dashboard, Closeout, Fuel, Maintenance — **no Accounting, no Payroll** |
| ManagementHeader (top of management pages) | Same set: no Accounting, no Payroll |
| `/closeout` | Loads, but no Driver Pay column |
| `/dashboard` | Loads, but the CSV/XLS export has no Driver Pay column |
| Settings | No Members section |
| Click any "Delete customer" / "Delete trailer" button | API returns 403 (UI not yet hiding the button) |

## 4. Verify the Maintenance experience

Change the test member's role to Maintenance (in **Settings → Members**,
edit the member, set role to `org:maintenance` if you've created that
custom role in Clerk; otherwise see "Custom roles" below).

Sign in as the test user again. You should see:

| Surface | Expected for Maintenance (`org:maintenance`) |
| --- | --- |
| Top nav | Just Calendar / Fuel / Maintenance |
| `/calendar` | Read-only — every mutating API call 403s |
| `/closeout`, `/accounting`, `/payroll`, `/dashboard` | Not navigable from the nav |
| `/maintenance`, `/fuel` | Full access (create / edit / delete reports) |

## Custom roles

If your Clerk org only has the built-in `org:admin` / `org:member` roles,
the test member's effective role will be:

- `org:admin` → **Admin** (full access)
- `org:member` → **Dispatcher** (mapped by `parseClerkRole`)

To test the **Maintenance** role properly, add it as a custom role in
Clerk's dashboard:

1. Clerk Dashboard → **Configure → Roles & Permissions → Roles**
2. **Add role**, name it `Maintenance`, key `org:maintenance`
3. Tick the permission set (at minimum `org:sys_memberships:read`)
4. Back in FleetCal **Settings → Members**, change a member's role to
   Maintenance

The same pattern works for `org:dispatcher` if you'd rather the slug
explicitly read "dispatcher" instead of "member."

## When something goes wrong

- **Test user sees admin UI even though they're a Member**: check
  Railway logs for `[clerkAuth] no recognized role in JWT` — if it
  fires, the JWT isn't carrying the role claim. See
  `docs/permissions-setup.md` for the Clerk Sessions config (default
  session token already carries `o.rol` — usually no custom claim
  needed).
- **403 on every API call**: the JWT carries an unknown role slug.
  Either add it to `ORG_ROLES` in `packages/types/permissions.ts` or
  reassign the member to a recognized role.
- **Role change doesn't apply**: tokens refresh on a ~60s cycle.
  Either wait a minute or sign the user out and back in.
