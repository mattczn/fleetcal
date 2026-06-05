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
  | "relay_advanced";    // gates relay handoff photo documentation (basic relay logic stays in StopsSection)

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
  "relay_advanced",
] as const;

/** Display labels (singular). Used in Settings → Modules toggles
 *  and the "module disabled" empty-state messaging. */
export const ORG_MODULE_LABEL: Record<OrgModule, string> = {
  closeout:           "Closeout",
  accounting:         "Accounting",
  fuel:               "Fuel",
  payroll:            "Payroll",
  maintenance:        "Maintenance",
  motive_integration: "Motive ELD",
  trailers:           "Trailers",
  performance:        "Performance & Analytics",
  driver_app:         "Driver mobile app",
  dispatch_board:     "Command Center",
  custom_documents:   "Custom document types",
  relay_advanced:     "Relay handoff documentation",
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
  relay_advanced:     "Photo upload + handoff documentation for relay-leg pickups (basic relay routing is included in core).",
};

// ── Check API ─────────────────────────────────────────────────────

/**
 * Returns true if the module is enabled for the org. An absent key
 * in the flags map is treated as ENABLED — this matters when a new
 * module is added in code before the DB column ships its default,
 * and avoids accidentally locking everyone out during a deploy.
 *
 * Explicit `false` is the only way to disable. `null` / `undefined`
 * flags maps (org_settings row missing entirely) → all modules ON.
 */
export function isModuleEnabled(
  module: OrgModule,
  flags: OrgModuleFlags | null | undefined,
): boolean {
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
export const MVP_LAUNCH_DEFAULTS: Required<Pick<OrgModuleFlags,
  | "closeout" | "accounting" | "fuel" | "payroll" | "maintenance"
  | "motive_integration" | "trailers" | "performance" | "driver_app"
  | "dispatch_board" | "custom_documents" | "relay_advanced"
>> = {
  // Pre-launch core modules — ON for MVP
  closeout:           true,
  accounting:         true,
  fuel:               true,
  payroll:            true,
  maintenance:        true,
  // MVP-launch additions — OFF by default, flip ON via tier upgrade
  motive_integration: false,
  trailers:           false,
  performance:        false,
  driver_app:         false,
  dispatch_board:     false,
  custom_documents:   false,
  relay_advanced:     false,
};
