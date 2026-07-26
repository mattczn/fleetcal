/**
 * @fleetcal/types — org-level module flags
 *
 * Modules are the SaaS-billing axis, orthogonal to per-role
 * capabilities (see permissions.ts). Capabilities answer "can this
 * USER perform this action?"; modules answer "does this ORG have
 * this feature at all?" A maintenance role with `closeout.access`
 * still can't see the Closeout page if the org's `closeout` module
 * is OFF — and likewise, an owner with full capabilities can't
 * either.
 *
 * Storage: `org_settings.modules` JSONB column (migration
 * 20260515_org_modules.sql). The default value populated by the
 * migration is `{closeout:true, accounting:true, fuel:true,
 * payroll:true, maintenance:true}` so every org keeps everything
 * until a billing event explicitly disables a module.
 *
 * Phase 2 wiring: Stripe subscription webhooks will PATCH the
 * `modules` field on org_settings when an org changes plans. For
 * now, an admin toggles modules manually in Settings → Modules.
 */

import type { OrgModuleFlags } from "./domain.js";

// ── Module taxonomy ────────────────────────────────────────────────

export type OrgModule =
  // Pre-launch core modules — see migration 20260515_org_modules.sql
  | "closeout"
  | "accounting"
  | "fuel"
  | "payroll"
  | "maintenance"
  // ── MVP-launch additions (2026-06-05) ───────────────────────────────
  // Added for the Starter/Growth/Fleet tier rollout. Each gates a
  // family of features that were promoted from CUT/DEFER/HIDE in the
  // MVP inventory (docs/mvp-feature-inventory.md + docs/mvp-
  // implementation-handoff.md). isModuleEnabled treats absent keys as
  // enabled, so existing orgs (Curzon) keep all features ON without
  // touching their org_settings row. New-org defaults of `false` for
  // these are set in the signup flow (Day 1 of launch week, not here).
  | "motive_integration" // gates the Motive ELD surfaces (asset live location, movements toggle, integration settings)
  | "trailers"           // gates trailer fleet map + trailer settings
  | "performance"        // gates the analytics surfaces (drivers scorecards, performance page, asset timeline, driver summary panel)
  | "driver_app"         // gates the driver-mobile companion features (notifications bell, driver-app settings)
  | "dispatch_board"     // gates the real-time Command Center board + the follow-up modal
  | "custom_documents"   // gates document-type customization in settings
  | "team_roles"         // gates multi-role / multi-dispatcher team management (Settings → Dispatchers + Role Permissions). OFF for MVP — every team member is an owner/admin to keep onboarding simple.
  | "trailer_categories" // gates the per-trailer Category field (Swing/Roll Up/Reefer/Flat Bed/Other). Off for MVP — most 1-14 truck carriers have a uniform fleet (all dry vans), so the category dropdown is noise. Curzon flips on for their mixed fleet.
  | "relay_advanced"     // gates relay handoff photo documentation (basic relay logic stays in StopsSection)
  | "invoicing_advanced" // gates the Advanced section in Settings → Invoicing (custom From-address, remit-to instructions, invoice-number prefix, footer notes, email template overrides). OFF for MVP — defaults work end-to-end. Carriers that want a custom invoice template or a verified domain flip this on per-org.
  // ── Internal-only modules (2026-07-02) ──────────────────────────────
  | "crm"                // INTERNAL sales tooling (FMCSA lead ingest, outreach, call queue). Never for customer orgs — default-OFF (see DEFAULT_OFF_MODULES) and double-gated by the internal-org allowlist on both API and web.
  // ── Cross-source spend surfaces (2026-07-07) ────────────────────────
  | "expenses";          // /expenses dashboard + Ramp card spend surface. Federated view over fuel_transactions, payroll_records, and ramp_transactions; buckets grow as more sources integrate (equipment depreciation, tolls, insurance).

export const ORG_MODULES: readonly OrgModule[] = [
  "closeout",
  "accounting",
  "fuel",
  "payroll",
  "maintenance",
  "motive_integration",
  "trailers",
  "performance",
  "driver_app",
  "dispatch_board",
  "custom_documents",
  "team_roles",
  "trailer_categories",
  "relay_advanced",
  "invoicing_advanced",
  "crm",
  "expenses",
] as const;

/** Display labels (singular). Used in Settings → Modules toggles
 *  and the "module disabled" empty-state messaging. */
export const ORG_MODULE_LABEL: Record<OrgModule, string> = {
  closeout:           "Paperwork",
  accounting:         "Billing",
  fuel:               "Fuel",
  payroll:            "Payroll",
  maintenance:        "Maintenance",
  motive_integration: "Motive ELD",
  trailers:           "Trailers",
  performance:        "Performance & Analytics",
  driver_app:         "Driver mobile app",
  dispatch_board:     "Command Center",
  custom_documents:   "Custom document types",
  team_roles:         "Multi-role team management",
  trailer_categories: "Trailer categories",
  relay_advanced:     "Relay handoff documentation",
  invoicing_advanced: "Advanced invoicing",
  crm:                "Sales CRM (internal)",
  expenses:           "Expenses dashboard",
};

/** Short description for the Settings → Modules toggle UI. */
export const ORG_MODULE_BLURB: Record<OrgModule, string> = {
  closeout:           "POD verification queue — review uploaded PODs and release loads to billing.",
  accounting:         "Billing pipeline — draft invoices, send to brokers, track payments.",
  fuel:               "Driver fuel-up reports — track gallons, DEF, and per-asset spend.",
  payroll:            "Per-driver weekly pay totals + adjustments (TONU, layover, deductions).",
  maintenance:        "Maintenance reports + action items — defects, repairs, asset history.",
  motive_integration: "Live truck location, driving-period history, and ELD movements view (requires Motive API key).",
  trailers:           "Trailer fleet roster + map view of last-known trailer locations.",
  performance:        "Per-driver and per-asset scorecards, revenue analytics, asset activity timeline.",
  driver_app:         "Companion mobile app for drivers — push notifications, POD upload from the road, in-app messaging.",
  dispatch_board:     "Real-time Command Center board for active dispatch with quick-action shortcuts and follow-up tasks.",
  custom_documents:   "Define your own document types (custom POD variants, broker-specific paperwork) for upload + tagging.",
  team_roles:         "Manage multi-role teams with distinct dispatcher accounts + customize per-role permissions. Without this, every team member is an admin.",
  trailer_categories: "Per-trailer category labels (Swing, Roll Up, Reefer, Flat Bed, Other). Useful for mixed fleets; most uniform-fleet carriers can leave this off.",
  relay_advanced:     "Photo upload + handoff documentation for relay-leg pickups (basic relay routing is included in core).",
  invoicing_advanced: "Advanced invoice template tweaks — custom From-address (own verified domain), remit-to block, invoice-number prefix, footer notes, outbound email template overrides. Defaults work end-to-end without this.",
  crm:                "FleetCal-internal sales tooling — FMCSA lead ingest, outreach sequences, call queue. Not a customer feature.",
  expenses:           "Cross-source expenses dashboard (fuel + payroll + card spend) with per-bucket rollups and the Ramp card-transaction board.",
};

// ── Check API ─────────────────────────────────────────────────────

/**
 * Modules that are OFF unless explicitly enabled — the inverse of the
 * absent-key-means-enabled rule below. Reserved for internal-only
 * surfaces (CRM) that must NEVER light up for customer orgs just
 * because their stored flags map predates the module's existence.
 * Flip one on by writing `{crm: true}` into the internal org's
 * org_settings.modules.
 */
export const DEFAULT_OFF_MODULES: ReadonlySet<OrgModule> = new Set<OrgModule>([
  "crm",
]);

/**
 * Returns true if the module is enabled for the org. An absent key
 * in the flags map is treated as ENABLED — this matters when a new
 * module is added in code before the DB column ships its default,
 * and avoids accidentally locking everyone out during a deploy.
 *
 * Explicit `false` is the only way to disable. `null` / `undefined`
 * flags maps (org_settings row missing entirely) → all modules ON.
 *
 * EXCEPTION: modules in DEFAULT_OFF_MODULES invert the rule — absent
 * (or missing flags map) means DISABLED, and explicit `true` is the
 * only way to enable. Internal-only surfaces opt in, never out.
 */
export function isModuleEnabled(
  module: OrgModule,
  flags: OrgModuleFlags | null | undefined,
): boolean {
  if (DEFAULT_OFF_MODULES.has(module)) return flags?.[module] === true;
  if (!flags) return true;
  return flags[module] !== false;
}

/**
 * The flag set for a brand-new org signing up after the MVP launch
 * (Friday 2026-06-12). Returned by GET /v1/org-settings when no row
 * exists yet, and used as the base for the PATCH upsert merge on a
 * first-write so the row gets seeded with explicit `false` for the
 * 7 MVP-launch additions instead of leaving them absent (= enabled).
 *
 * Existing orgs (pre-2026-06-12, e.g. Curzon) keep working without
 * a row migration because the 7 new flag keys are simply absent from
 * their stored modules JSONB, and `isModuleEnabled` treats absent
 * as enabled. So this constant changes behaviour ONLY for new orgs.
 *
 * To upgrade a customer's tier later, PATCH the specific flags from
 * `false` to `true` via Settings → Modules (or a Stripe webhook).
 */
// Typed as a TOTAL map over OrgModule (not a Pick of hand-listed keys)
// so the compiler refuses to build when a new module is added to the
// union without a launch default. The previous Pick<> shape let
// `expenses` ship in ORG_MODULES with no entry here, and since
// isModuleEnabled treats an absent key as ENABLED, every new org
// silently got the Expenses dashboard. Adding a module is now a
// two-line change by construction: the union, and this map.
export const MVP_LAUNCH_DEFAULTS: Readonly<Record<OrgModule, boolean>> = {
  // Pre-launch core modules
  // - closeout / accounting / payroll: core to the rate-con-to-paid
  //   hero workflow → ON.
  // - fuel / maintenance: Equipment workflows (Maintenance / Inspections /
  //   Fuel sub-tabs) are explicitly out of MVP scope per founder
  //   definition → OFF. Hides the Equipment nav group entirely for new
  //   orgs via the existing module: 'maintenance' gate in AppSidebar.
  closeout:           true,
  accounting:         true,
  payroll:            true,
  fuel:               false,
  maintenance:        false,
  // MVP-launch additions — OFF by default, flip ON via tier upgrade
  motive_integration: false,
  // Trailers: ON for MVP. Carriers want to assign trailers to loads
  // on day one (their drivers ask "which trailer am I pulling?"); the
  // Motive ELD trailer-tracking add-ons (fleet map, live GPS pins)
  // remain off via motive_integration.
  trailers:           true,
  performance:        false,
  // Driver app: ON for MVP as of 2026-06-22. The mobile companion app
  // is multi-tenant now (any org's drivers can sign in), so the Notify
  // Driver popover (confirm load / mark picked up / mark delivered /
  // upload POD / report trailer) and the Settings → Driver App tab
  // both have a real receiver on the other end for every new org. No
  // reason to hide them anymore — the value showed up the moment the
  // app stopped being Curzon-only.
  driver_app:         true,
  dispatch_board:     false,
  custom_documents:   false,
  team_roles:         false,
  // Trailer categories: OFF for MVP. Most small carriers run a uniform
  // fleet (all dry vans), so the category dropdown is dead UI. Mixed
  // fleets like Curzon flip this on per-org from Settings → Modules.
  trailer_categories: false,
  relay_advanced:     false,
  // Invoicing advanced: OFF for MVP. The defaults (companyName +
  // billing address + contact + net-30 terms + platform From-address)
  // produce a sendable invoice end-to-end. Carriers that want a
  // custom remit-to block, an invoice-number prefix, custom email
  // templates, or their own verified From-domain flip this on
  // per-org from Settings → Modules.
  invoicing_advanced: false,
  // Internal-only: sales CRM. Explicit false for every new org; the
  // internal org opts in with {crm: true}. Also default-off via
  // DEFAULT_OFF_MODULES even when the key is absent.
  crm:                false,
  // Expenses: OFF for MVP. The dashboard federates fuel_transactions,
  // payroll_records, and ramp_transactions — and the Ramp card-spend
  // board behind it is Curzon-only plumbing (rampSyncSweep hardcodes
  // their org id). Two of the three sources are themselves off for new
  // orgs (fuel), so the page would render mostly-empty buckets anyway.
  // Flip on per-org once a carrier has a card integration worth
  // aggregating.
  expenses:           false,
};

// ── Resolution ────────────────────────────────────────────────────

/** An org's effective module map. Every OrgModule key is present with
 *  an explicit boolean — no absent keys, so `isModuleEnabled`'s
 *  absent-means-enabled fallback can't fire on a resolved map. */
export type ResolvedOrgModules = Record<OrgModule, boolean>;

/**
 * Turn an org's STORED flags into its EFFECTIVE flags.
 *
 * This is the single definition of that rule. It used to be written
 * out at six call sites — GET and PATCH /v1/org-settings, the
 * requireModule guard, two driver-app endpoints, and the admin
 * portal — and on 2026-07-26 two of those copies disagreed: the guard
 * read the stored map raw while the settings endpoint layered the
 * defaults. A brand-new org has NO org_settings row (it's written on
 * the first save), so the guard saw `{}`, absent-means-enabled fired,
 * and every module-gated route answered for an org whose nav
 * correctly hid those same features. Module gating was UI-only for
 * exactly the orgs the MVP module set was written for, and nothing
 * errored — the two paths just quietly disagreed about entitlement.
 *
 * Any new reader of org_settings.modules calls this instead of
 * spreading by hand.
 *
 * Layering, not flag-flipping: MVP_LAUNCH_DEFAULTS is a TOTAL map
 * over OrgModule (compiler-enforced above), so the result always
 * carries every key and a module is on only if the launch set says so
 * or the org explicitly enabled it.
 *
 * FUTURE — per-plan module bundles: when tiers stop sharing one
 * module set, the base layer becomes a function of the org's plan
 * (`PLAN_BUNDLE[tier] ← stored`) and this is the only body that
 * changes. Add the tier as a second, optional parameter so existing
 * callers keep compiling, and have callers that know the tier pass
 * it. Storing only DEVIATIONS is what makes that work — see the note
 * on the PATCH handler in routes/org-settings.ts, which currently
 * stamps the full resolved map and therefore pins an org to the
 * defaults in force the day it first saved.
 */
export function resolveOrgModules(
  stored: OrgModuleFlags | null | undefined,
): ResolvedOrgModules {
  // Spreading a null/empty stored map is a no-op, so this covers the
  // "no row at all" and "row with empty map" cases without the
  // has-any-keys branch the old call sites carried.
  return { ...MVP_LAUNCH_DEFAULTS, ...(stored ?? {}) };
}
