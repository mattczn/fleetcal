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
 * Roles map 1:1 to Clerk's org role slugs (`org:owner`, `org:admin`,
 * `org:dispatcher`, `org:maintenance`). The Clerk dashboard owns
 * membership / invitations; this module owns "what can this role
 * actually do." Owner is Clerk's built-in creator role; admin /
 * dispatcher / maintenance must be added as custom roles in the Clerk
 * dashboard (see /docs/permissions-setup.md).
 */

// ── Role taxonomy ────────────────────────────────────────────────────────

export type OrgRole = "owner" | "admin" | "dispatcher" | "maintenance";

export const ORG_ROLES: readonly OrgRole[] = [
  "owner",
  "admin",
  "dispatcher",
  "maintenance",
] as const;

/** Display labels (singular). Used in UI dropdowns / badges. */
export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  owner:       "Owner",
  admin:       "Admin",
  dispatcher:  "Dispatcher",
  maintenance: "Maintenance",
};

/** Short description shown next to the label in pickers. */
export const ORG_ROLE_BLURB: Record<OrgRole, string> = {
  owner:       "Full control. Can transfer or delete the organization.",
  admin:       "Full operational + billing access. Manages members and settings.",
  dispatcher:  "Day-to-day operations. Creates and edits loads; cannot finalize billing or change org settings.",
  maintenance: "Read-only calendar. Full access to Maintenance and Fuel.",
};

/**
 * Ordering — for "at least admin" style comparisons. NOT used for
 * capability checks (those go through the explicit matrix below).
 */
export const ROLE_RANK: Record<OrgRole, number> = {
  maintenance: 0,
  dispatcher:  1,
  admin:       2,
  owner:       3,
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

  // Customers / brokers
  | "customers.view"
  | "customers.edit"
  | "customers.delete"

  // Drivers / assets / trailers
  | "drivers.view"
  | "drivers.edit"
  | "drivers.delete"
  | "assets.view"
  | "assets.edit"
  | "assets.delete"
  | "trailers.view"
  | "trailers.edit"
  | "trailers.delete"
  | "savedLocations.edit"
  | "savedLocations.delete"
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
  | "reports.access";

// ── Capability matrix ────────────────────────────────────────────────────
//
// Anything not in a role's list is forbidden. Owner and admin both
// receive every capability so a typo in this list can't accidentally
// lock the owner out of a screen they need.

const ALL_CAPS: Capability[] = [
  "org.settings.edit", "org.members.manage",
  "loads.view", "loads.create", "loads.edit", "loads.delete", "loads.view_driver_pay",
  "customers.view", "customers.edit", "customers.delete",
  "drivers.view", "drivers.edit", "drivers.delete",
  "assets.view", "assets.edit", "assets.delete",
  "trailers.view", "trailers.edit", "trailers.delete",
  "savedLocations.edit", "savedLocations.delete",
  "dispatchers.edit", "dispatchers.delete",
  "closeout.access", "closeout.release", "closeout.flag",
  "accounting.access", "accounting.send_invoice",
  "payroll.access", "payroll.adjust", "payroll.finalize",
  "maintenance.access", "maintenance.edit",
  "fuel.access", "fuel.edit",
  "dashboard.access", "reports.access",
];

export const ROLE_CAPABILITIES: Record<OrgRole, ReadonlySet<Capability>> = {
  owner: new Set(ALL_CAPS),
  admin: new Set(ALL_CAPS),

  // Dispatcher: day-to-day operations. Reads everything operations-
  // related, edits loads/customers/drivers/trailers, runs closeout.
  // BUT — no destructive deletes, no payroll/accounting, no org
  // settings or member management, no dashboard (those KPIs include
  // revenue / driver-pay numbers we don't want at this tier), and
  // driver pay is hidden.
  dispatcher: new Set<Capability>([
    "loads.view", "loads.create", "loads.edit",
    "customers.view", "customers.edit",
    "drivers.view", "drivers.edit",
    "assets.view", "assets.edit",
    "trailers.view", "trailers.edit",
    "savedLocations.edit", "dispatchers.edit",
    "closeout.access", "closeout.release", "closeout.flag",
    "maintenance.access", "maintenance.edit",
    "fuel.access", "fuel.edit",
    "reports.access",
  ]),

  // Maintenance: stripped-down nav. Sees the calendar but can't
  // touch anything there; full access to Maintenance + Fuel.
  maintenance: new Set<Capability>([
    "loads.view",
    "customers.view", "drivers.view", "trailers.view", "assets.view",
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
  { cap: "dashboard.access",  label: "Dashboard",     group: "Module access", hint: "Top-line KPIs, revenue + driver pay totals." },
  { cap: "closeout.access",   label: "Closeout",      group: "Module access", hint: "POD verification + flag queue." },
  { cap: "accounting.access", label: "Accounting",    group: "Module access", hint: "Invoice list, send/void, payment status." },
  { cap: "payroll.access",    label: "Payroll",       group: "Module access", hint: "Per-driver weekly pay + adjustments." },
  { cap: "fuel.access",       label: "Fuel",          group: "Module access" },
  { cap: "maintenance.access", label: "Maintenance",  group: "Module access" },
  { cap: "reports.access",    label: "Reports",       group: "Module access", hint: "LoadsReport + future custom-report endpoints." },

  // Create / Edit — day-to-day ops.
  { cap: "loads.create",        label: "Create loads",         group: "Create / Edit" },
  { cap: "loads.edit",          label: "Edit loads",           group: "Create / Edit" },
  { cap: "customers.edit",      label: "Edit customers",       group: "Create / Edit" },
  { cap: "drivers.edit",        label: "Edit drivers",         group: "Create / Edit" },
  { cap: "assets.edit",         label: "Edit assets",          group: "Create / Edit" },
  { cap: "trailers.edit",       label: "Edit trailers",        group: "Create / Edit" },
  { cap: "savedLocations.edit", label: "Edit saved locations", group: "Create / Edit" },
  { cap: "dispatchers.edit",    label: "Edit dispatchers",     group: "Create / Edit" },

  // Delete — destructive.
  { cap: "loads.delete",          label: "Delete loads",          group: "Delete" },
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

  // Org admin.
  { cap: "org.settings.edit",  label: "Edit org settings",    group: "Org admin" },
  { cap: "org.members.manage", label: "Manage members + roles", group: "Org admin" },
];

/**
 * Maps the raw Clerk role slug ("org:dispatcher") to our typed role
 * ("dispatcher"). Returns undefined for unrecognized slugs so callers
 * can fall through to "no permission" cleanly.
 */
export function parseClerkRole(slug: string | null | undefined): OrgRole | undefined {
  if (!slug) return undefined;
  const stripped = slug.startsWith("org:") ? slug.slice(4) : slug;
  if ((ORG_ROLES as readonly string[]).includes(stripped)) return stripped as OrgRole;
  // Clerk's built-in admin slug. Map to our admin so existing orgs
  // (where everyone is org:admin or org:member) don't lock out.
  if (stripped === "admin") return "admin";
  // Treat anyone else (member, custom, etc.) as dispatcher — same
  // baseline as before this feature shipped.
  if (stripped === "member") return "dispatcher";
  return undefined;
}
