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
  | "closeout"
  | "accounting"
  | "fuel"
  | "payroll"
  | "maintenance";

export const ORG_MODULES: readonly OrgModule[] = [
  "closeout",
  "accounting",
  "fuel",
  "payroll",
  "maintenance",
] as const;

/** Display labels (singular). Used in Settings → Modules toggles
 *  and the "module disabled" empty-state messaging. */
export const ORG_MODULE_LABEL: Record<OrgModule, string> = {
  closeout:    "Closeout",
  accounting:  "Accounting",
  fuel:        "Fuel",
  payroll:     "Payroll",
  maintenance: "Maintenance",
};

/** Short description for the Settings → Modules toggle UI. */
export const ORG_MODULE_BLURB: Record<OrgModule, string> = {
  closeout:    "POD verification queue — review uploaded PODs and release loads to billing.",
  accounting:  "Billing pipeline — draft invoices, send to brokers, track payments.",
  fuel:        "Driver fuel-up reports — track gallons, DEF, and per-asset spend.",
  payroll:     "Per-driver weekly pay totals + adjustments (TONU, layover, deductions).",
  maintenance: "Maintenance reports + action items — defects, repairs, asset history.",
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
