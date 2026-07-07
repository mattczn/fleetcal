/**
 * @fleetcal/types — role + capability model
 *
 * SINGLE SOURCE OF TRUTH for what each org role is allowed to do.
 * Imported by both the dispatch web app (UI gating) and the Hono API
 * (request-level enforcement). Anywhere in the stack that asks "can
 * this user X?" must route through `can()` so the answer is consistent
 * across the two halves of the system.
 *
 * Why capabilities (verb-noun strings) rather than role-based checks
 * scattered through the code:
 *   - "if (role === 'admin')" gets duplicated and drifts. Capability
 *     checks read like the action being taken ("loads.delete") and
 *     keep the role→action mapping in ONE table.
 *   - Adding a role later is a single matrix edit. Adding a new
 *     destructive action is a single capability addition.
 *
 * Roles map to Clerk's org role slugs:
 *   - `org:admin`       — Clerk's built-in admin (also covers org creator)
 *   - `dispatcher`      — comes through as Clerk's built-in `org:member`
 *                         (renamed "Dispatcher" in the Clerk dashboard if
 *                         desired; parseClerkRole maps `member → dispatcher`
 *                         either way)
 *   - `org:maintenance` — custom Clerk role (equipment-focused, read-only
 *                         calendar). Requires a paid Clerk plan; created in
 *                         the Clerk dashboard with the `org:maintenance` key.
 *
 * Adding a role is a single matrix edit here PLUS creating the matching
 * `org:<slug>` role in the Clerk dashboard. The Role Permissions settings
 * panel (gated by the `team_roles` module) then lets an admin tune each
 * role's capabilities per-org via org_settings.role_overrides.
 */

// ── Role taxonomy ────────────────────────────────────────────────────────

export type OrgRole = "admin" | "dispatcher" | "maintenance";

export const ORG_ROLES: readonly OrgRole[] = [
  "admin",
  "dispatcher",
  "maintenance",
] as const;

/** Display labels (singular). Used in UI dropdowns / badges. */
export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  admin:       "Admin",
  dispatcher:  "Dispatcher",
  maintenance: "Maintenance",
};

/** Short description shown next to the label in pickers. */
export const ORG_ROLE_BLURB: Record<OrgRole, string> = {
  admin:       "Full operational + billing access. Manages members and settings.",
  dispatcher:  "Day-to-day operations. Creates and edits loads; cannot finalize billing or change org settings.",
  maintenance: "Equipment + fuel: maintenance reports, inspections, asset history. Read-only calendar; no pricing, payroll, or org settings.",
};

/**
 * Ordering — for "at least admin" style comparisons. NOT used for
 * capability checks (those go through the explicit matrix below).
 * Maintenance is the most limited role, below dispatcher.
 */
export const ROLE_RANK: Record<OrgRole, number> = {
  maintenance: 0,
  dispatcher:  1,
  admin:       2,
};

/** True if `role` outranks or equals `min`. */
export function roleAtLeast(role: OrgRole | undefined, min: OrgRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

// ── Capabilities ─────────────────────────────────────────────────────────
//
// Each capability is a single permission the app cares about. Group
// prefix mirrors the feature area so checks read naturally:
//
//   can(role, "loads.delete")
//   can(role, "payroll.finalize")
//
// Add a capability whenever a piece of code wants to gate behavior on
// role. DO NOT add a "everything" capability — keep them granular so
// roles can be reshaped without code edits.

export type Capability =
  // Org-level admin
  | "org.settings.edit"
  | "org.members.manage"

  // Calendar / loads — Dispatcher full; Maintenance read-only
  | "loads.view"
  | "loads.create"
  | "loads.edit"
  | "loads.delete"
  // Visibility-only gate — driver pay field on cards, modals, reports.
  // Owner/Admin have it; Dispatcher + Maintenance don't, unless the
  // org explicitly opts in (Phase 3 setting).
  | "loads.view_driver_pay"
  // Visibility-only gate — load rate / revenue figures (loadPrice,
  // accessorials, total). Owner/Admin/Dispatcher have it by default;
  // Maintenance does NOT, so a maintenance user opening a load card
  // sees the route and stops but no dollar amounts.
  | "loads.view_price"
  // Visibility-only gate — the rate confirmation PDF/document on a
  // load. Same default audience as loads.view_price: Owner / Admin /
  // Dispatcher have it; Maintenance does not (the rate con contains
  // pricing, broker terms, and other operational details they don't
  // need).
  | "loads.view_rate_con"
  // Non-revenue calendar events — maintenance/repair blocks, asset
  // out-of-service holds, etc. Distinct from loads.* so a Maintenance
  // role can manage their own events without being able to touch
  // revenue loads. The API checks event_kind on POST/PATCH/DELETE
  // and applies either loads.* OR nonRevenueEvents.* based on the
  // event's kind.
  | "nonRevenueEvents.create"
  | "nonRevenueEvents.edit"
  | "nonRevenueEvents.delete"

  // Customers / brokers
  | "customers.view"
  | "customers.create"
  | "customers.edit"
  | "customers.delete"

  // Drivers / assets / trailers
  | "drivers.view"
  | "drivers.create"
  | "drivers.edit"
  | "drivers.delete"
  | "assets.view"
  | "assets.create"
  | "assets.edit"
  | "assets.delete"
  | "trailers.view"
  | "trailers.create"
  | "trailers.edit"
  | "trailers.delete"
  | "savedLocations.create"
  | "savedLocations.edit"
  | "savedLocations.delete"
  | "dispatchers.create"
  | "dispatchers.edit"
  | "dispatchers.delete"

  // Closeout — POD verification + flagging. Dispatcher gets it; Maintenance does not.
  | "closeout.access"
  | "closeout.release"
  | "closeout.flag"

  // Accounting + payroll — Admin/Owner only by default
  | "accounting.access"
  | "accounting.send_invoice"
  | "payroll.access"
  | "payroll.adjust"
  | "payroll.finalize"

  // Maintenance / fuel — Maintenance role's home turf
  | "maintenance.access"
  | "maintenance.edit"
  | "fuel.access"
  | "fuel.edit"

  // Dashboard / reports
  | "dashboard.access"
  | "reports.access"

  // CRM — INTERNAL sales tooling (FMCSA leads, outreach, call queue).
  // Admin-only by default; grant `crm.access` to dispatcher via
  // role_overrides if sales hires shouldn't be full admins. Both caps
  // are additionally gated by the `crm` module flag AND the internal-
  // org allowlist, so granting them to a customer org's role does
  // nothing.
  | "crm.access"   // see + work the CRM (leads, call queue, outbox)
  | "crm.manage";  // edit sequences, CRM settings, trigger syncs

// ── Capability matrix ────────────────────────────────────────────────────
//
// Anything not in a role's list is forbidden. Admin receives every
// capability so a typo in this list can't accidentally lock them out
// of a screen they need.

const ALL_CAPS: Capability[] = [
  "org.settings.edit", "org.members.manage",
  "loads.view", "loads.create", "loads.edit", "loads.delete", "loads.view_driver_pay", "loads.view_price", "loads.view_rate_con",
  "nonRevenueEvents.create", "nonRevenueEvents.edit", "nonRevenueEvents.delete",
  "customers.view", "customers.create", "customers.edit", "customers.delete",
  "drivers.view", "drivers.create", "drivers.edit", "drivers.delete",
  "assets.view", "assets.create", "assets.edit", "assets.delete",
  "trailers.view", "trailers.create", "trailers.edit", "trailers.delete",
  "savedLocations.create", "savedLocations.edit", "savedLocations.delete",
  "dispatchers.create", "dispatchers.edit", "dispatchers.delete",
  "closeout.access", "closeout.release", "closeout.flag",
  "accounting.access", "accounting.send_invoice",
  "payroll.access", "payroll.adjust", "payroll.finalize",
  "maintenance.access", "maintenance.edit",
  "fuel.access", "fuel.edit",
  "dashboard.access", "reports.access",
  "crm.access", "crm.manage",
];

export const ROLE_CAPABILITIES: Record<OrgRole, ReadonlySet<Capability>> = {
  admin: new Set(ALL_CAPS),

  // Dispatcher: day-to-day operations. Reads everything operations-
  // related, edits loads/customers/drivers/trailers, runs closeout.
  // BUT — no destructive deletes, no payroll/accounting, no org
  // settings or member management, no dashboard (those KPIs include
  // revenue / driver-pay numbers we don't want at this tier), and
  // driver pay is hidden. Maintenance + fuel are included so a
  // dispatcher can manage repair holds and fuel-up entries without
  // needing a separate role (we dropped the dedicated maintenance role
  // when consolidating to Clerk free-tier's 2 built-in slugs).
  dispatcher: new Set<Capability>([
    "loads.view", "loads.create", "loads.edit", "loads.view_price", "loads.view_rate_con",
    "nonRevenueEvents.create", "nonRevenueEvents.edit", "nonRevenueEvents.delete",
    "customers.view", "customers.create", "customers.edit",
    "drivers.view", "drivers.create", "drivers.edit",
    "assets.view", "assets.create", "assets.edit",
    "trailers.view", "trailers.create", "trailers.edit",
    "savedLocations.create", "savedLocations.edit",
    "dispatchers.create", "dispatchers.edit",
    "closeout.access", "closeout.release", "closeout.flag",
    "maintenance.access", "maintenance.edit",
    "fuel.access", "fuel.edit",
    "reports.access",
  ]),

  // Maintenance: equipment-focused. Home turf is the Equipment module
  // (maintenance reports + inspections + asset history) and Fuel. Sees
  // assets/trailers/drivers (equipment history references driver names)
  // and gets a READ-ONLY calendar (loads.view) so they can see the
  // schedule — but WITHOUT pricing, driver pay, or the rate con, and
  // without create/edit/delete on loads. No payroll, accounting,
  // dashboard, closeout, or org settings. Everything here is tunable
  // per-org in the Role Permissions matrix.
  maintenance: new Set<Capability>([
    "loads.view",
    "assets.view", "trailers.view",
    "drivers.view",
    "maintenance.access", "maintenance.edit",
    "fuel.access", "fuel.edit",
  ]),
};

// ── Check API ────────────────────────────────────────────────────────────

/**
 * Returns true iff the role has the capability per the HARDCODED
 * defaults. `undefined` role always returns false — treat absence as
 * denial.
 *
 * Most callers should use `effectiveCan(role, cap, overrides)`
 * instead — it factors in per-org overrides from org_settings. This
 * default-only `can()` is still exposed for places that explicitly
 * want the unconfigurable baseline (e.g. tests, internal jobs).
 */
export function can(role: OrgRole | undefined, cap: Capability): boolean {
  if (!role) return false;
  return ROLE_CAPABILITIES[role]?.has(cap) ?? false;
}

/**
 * Same shape as `can`, plus a per-org override map. The override
 * lookup goes:
 *   overrides[role][cap] === true   → granted
 *   overrides[role][cap] === false  → revoked
 *   key absent                      → fall back to the hardcoded default
 *
 * Admins use this to take a capability away from a role (or grant a
 * normally-restricted cap to a role) without a code deploy. Storage
 * for the override map is `org_settings.role_overrides` jsonb.
 */
export function effectiveCan(
  role: OrgRole | undefined,
  cap: Capability,
  overrides?: Partial<Record<string, Record<string, boolean>>> | null,
): boolean {
  if (!role) return false;
  const override = overrides?.[role]?.[cap];
  if (override === true)  return true;
  if (override === false) return false;
  return ROLE_CAPABILITIES[role]?.has(cap) ?? false;
}

// ── Presentation metadata for the admin matrix UI ────────────────────────
//
// Drives the "Role Permissions" settings panel. Each capability gets a
// human-readable label and a group; groups render as section headers
// in the matrix. Owner is always read-only; Admin should also be in
// practice but we let the UI display them so the consequences are
// visible.

export type CapabilityGroup =
  | "Module access"
  | "Create / Edit"
  | "Delete"
  | "Closeout actions"
  | "Billing actions"
  | "Payroll actions"
  | "Maintenance / Fuel"
  | "Sensitive fields"
  | "Org admin";

export interface CapabilityInfo {
  cap:   Capability;
  label: string;
  group: CapabilityGroup;
  /** Short, plain-English description shown as a tooltip in the
   *  matrix UI. Optional — many capabilities are self-explanatory. */
  hint?: string;
}

export const CAPABILITY_CATALOG: CapabilityInfo[] = [
  // Module access — top-nav visibility.
  { cap: "loads.view",        label: "Calendar",      group: "Module access", hint: "See the load calendar (read-only for roles without create/edit). Turn off to hide the schedule entirely from a role." },
  { cap: "dashboard.access",  label: "Dashboard",     group: "Module access", hint: "Top-line KPIs, revenue + driver pay totals." },
  { cap: "closeout.access",   label: "Paperwork",     group: "Module access", hint: "POD verification + flag queue." },
  { cap: "accounting.access", label: "Billing",       group: "Module access", hint: "Invoice list, send/void, payment status." },
  { cap: "payroll.access",    label: "Payroll",       group: "Module access", hint: "Per-driver weekly pay + adjustments." },
  { cap: "fuel.access",       label: "Fuel",          group: "Module access" },
  { cap: "maintenance.access", label: "Maintenance",  group: "Module access" },
  { cap: "reports.access",    label: "Reports",       group: "Module access", hint: "LoadsReport + future custom-report endpoints." },

  // Create / Edit — day-to-day ops. Create and Edit are split per
  // entity so an admin can grant "edit existing" without "add new"
  // (or vice versa). The API enforces each separately.
  { cap: "loads.create",          label: "Create loads",          group: "Create / Edit" },
  { cap: "loads.edit",            label: "Edit loads",            group: "Create / Edit" },
  { cap: "nonRevenueEvents.create", label: "Create non-revenue events", group: "Create / Edit", hint: "Maintenance blocks, repair holds, asset out-of-service windows — anything on the calendar that isn't a paying load." },
  { cap: "nonRevenueEvents.edit",   label: "Edit non-revenue events",   group: "Create / Edit" },
  { cap: "customers.create",      label: "Create customers",      group: "Create / Edit" },
  { cap: "customers.edit",        label: "Edit customers",        group: "Create / Edit" },
  { cap: "drivers.create",        label: "Create drivers",        group: "Create / Edit" },
  { cap: "drivers.edit",          label: "Edit drivers",          group: "Create / Edit" },
  { cap: "assets.create",         label: "Create assets",         group: "Create / Edit" },
  { cap: "assets.edit",           label: "Edit assets",           group: "Create / Edit" },
  { cap: "trailers.create",       label: "Create trailers",       group: "Create / Edit" },
  { cap: "trailers.edit",         label: "Edit trailers",         group: "Create / Edit" },
  { cap: "savedLocations.create", label: "Create saved locations", group: "Create / Edit" },
  { cap: "savedLocations.edit",   label: "Edit saved locations",   group: "Create / Edit" },
  { cap: "dispatchers.create",    label: "Create dispatchers",    group: "Create / Edit" },
  { cap: "dispatchers.edit",      label: "Edit dispatchers",      group: "Create / Edit" },

  // Delete — destructive.
  { cap: "loads.delete",            label: "Delete loads",          group: "Delete" },
  { cap: "nonRevenueEvents.delete", label: "Delete non-revenue events", group: "Delete" },
  { cap: "customers.delete",      label: "Delete customers",      group: "Delete" },
  { cap: "drivers.delete",        label: "Delete drivers",        group: "Delete" },
  { cap: "assets.delete",         label: "Delete assets",         group: "Delete" },
  { cap: "trailers.delete",       label: "Delete trailers",       group: "Delete" },
  { cap: "savedLocations.delete", label: "Delete saved locations", group: "Delete" },
  { cap: "dispatchers.delete",    label: "Delete dispatchers",    group: "Delete" },

  // Closeout actions.
  { cap: "closeout.release", label: "Release loads", group: "Closeout actions", hint: "Mark POD verified, move to accounting." },
  { cap: "closeout.flag",    label: "Flag loads",    group: "Closeout actions" },

  // Billing.
  { cap: "accounting.send_invoice", label: "Send invoices", group: "Billing actions" },

  // Payroll.
  { cap: "payroll.adjust",   label: "Add / remove payroll adjustments", group: "Payroll actions" },
  { cap: "payroll.finalize", label: "Finalize + un-finalize payroll",   group: "Payroll actions" },

  // Maintenance / Fuel.
  { cap: "maintenance.edit", label: "Edit maintenance records", group: "Maintenance / Fuel" },
  { cap: "fuel.edit",        label: "Edit fuel reports",        group: "Maintenance / Fuel" },

  // Sensitive fields.
  { cap: "loads.view_driver_pay", label: "View driver pay", group: "Sensitive fields", hint: "Hides the Driver Pay column / field across reports, modals, and exports." },
  { cap: "loads.view_price",      label: "View load price", group: "Sensitive fields", hint: "Hides the load rate / revenue / total across the load modal, cards, dashboard, and reports." },
  { cap: "loads.view_rate_con",   label: "View rate confirmation", group: "Sensitive fields", hint: "Hides the rate confirmation PDF and the View PDF buttons on the load modal." },

  // Org admin.
  { cap: "org.settings.edit",  label: "Edit org settings",    group: "Org admin" },
  { cap: "org.members.manage", label: "Manage members + roles", group: "Org admin" },
];

/**
 * Maps the raw Clerk role slug (e.g. `org:admin`, `org:member`,
 * `org:dispatcher`) to our typed role. Returns undefined for
 * unrecognized slugs so callers can fall through to "no permission"
 * cleanly.
 *
 * Slug handling:
 *   - `admin`               → admin
 *   - `creator` / `owner`   → admin (Clerk's org-creator legacy slugs)
 *   - `dispatcher`          → dispatcher (if a custom role got created)
 *   - `member`              → dispatcher (Clerk free tier default;
 *                             we treat the built-in member role as our
 *                             dispatcher even if it wasn't renamed)
 *   - anything else         → undefined (denied)
 */
export function parseClerkRole(slug: string | null | undefined): OrgRole | undefined {
  if (!slug) return undefined;
  const stripped = slug.startsWith("org:") ? slug.slice(4) : slug;
  if (stripped === "admin")       return "admin";
  if (stripped === "creator")     return "admin";  // some Clerk instances use this for the org creator
  if (stripped === "owner")       return "admin";  // legacy slug from when we had an owner role
  if (stripped === "dispatcher")  return "dispatcher";
  if (stripped === "member")      return "dispatcher";  // Clerk's built-in member role = our dispatcher
  if (stripped === "maintenance") return "maintenance"; // custom Clerk role (org:maintenance)
  return undefined;
}
