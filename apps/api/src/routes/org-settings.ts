/**
 * /v1/org-settings — per-org preferences.
 *
 * Defaults when no row exists yet:
 *   showDriverPay  = false
 *   rateConSettings = {} (empty; client falls back to its built-in defaults)
 *   invoiceSettings = {}
 *   roleOverrides  = {} (no overrides; defaults from @fleetcal/types/permissions apply)
 *
 * Other org_settings columns (motive_api_key etc.) are intentionally not
 * exposed here — they're read by server-side proxies only.
 */

import { Hono } from "hono";
import {
  type GetOrgSettingsResponse,
  type RateConSettings,
  type InvoiceSettings,
  type RoleOverrides,
  type OrgModuleFlags,
  type NotificationRules,
  type UpdateOrgSettingsRequest,
  type UpdateOrgSettingsResponse,
  type ApiErrorResponse,
  type DocumentTypeConfig,
  DOCUMENT_KINDS,
  DRIVER_HIDDEN_DOC_KINDS,
  MVP_LAUNCH_DEFAULTS,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, invalidateRoleOverrides, invalidateOrgModules } from "../middleware/require.js";

const orgSettings = new Hono<{ Variables: AuthVariables }>();

orgSettings.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("org_settings")
    .select("show_driver_pay,rate_con_settings,invoice_settings,role_overrides,modules,driver_visible_doc_kinds,document_types,notification_rules,motive_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/org-settings] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const row = data as {
    show_driver_pay:           boolean;
    rate_con_settings:         RateConSettings        | null;
    invoice_settings:          InvoiceSettings        | null;
    role_overrides:            RoleOverrides          | null;
    modules:                   OrgModuleFlags         | null;
    driver_visible_doc_kinds:  string[]               | null;
    document_types:            DocumentTypeConfig[]   | null;
    notification_rules:        NotificationRules      | null;
    motive_settings:           import("@fleetcal/types").MotiveSettings | null;
  } | null;
  // orgModules fallback: return MVP launch defaults when either (a) no
  // row exists at all, or (b) a row exists but `modules` is null /
  // empty `{}`. The empty-object case fires when a settings PATCH ran
  // against a brand-new org BEFORE this file's PATCH handler started
  // seeding with MVP_LAUNCH_DEFAULTS — that path used to write
  // `modules: {}`, and an empty-object isn't caught by `??`, so without
  // this check the org silently saw absent-key-as-enabled for every
  // module (all features re-enabled) for the lifetime of the row.
  //
  // Curzon's row has the OLD 5-flag default ({closeout:true, ...,
  // maintenance:true}) — that's >0 keys, so this branch returns it
  // unchanged and Curzon keeps absent-key-as-enabled for the 7 new
  // flags = everything ON. No migration needed.
  const storedModules    = row?.modules ?? null;
  const hasStoredModules = storedModules !== null && Object.keys(storedModules).length > 0;
  const orgModulesOut    = hasStoredModules ? storedModules! : MVP_LAUNCH_DEFAULTS;

  const res: GetOrgSettingsResponse = {
    settings: {
      showDriverPay:         row?.show_driver_pay         ?? false,
      rateConSettings:       row?.rate_con_settings       ?? {},
      invoiceSettings:       row?.invoice_settings        ?? {},
      roleOverrides:         row?.role_overrides          ?? {},
      orgModules:            orgModulesOut,
      driverVisibleDocKinds: row?.driver_visible_doc_kinds ?? null,
      documentTypes:         row?.document_types          ?? null,
      notificationRules:     row?.notification_rules      ?? null,
      motiveSettings:        row?.motive_settings         ?? null,
    },
  };
  return c.json(res);
});

orgSettings.patch("/", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<UpdateOrgSettingsRequest>();
  // At least one allowed key must be present.
  if (
    body.showDriverPay         === undefined &&
    body.rateConSettings       === undefined &&
    body.invoiceSettings       === undefined &&
    body.roleOverrides         === undefined &&
    body.orgModules            === undefined &&
    body.driverVisibleDocKinds === undefined &&
    body.documentTypes         === undefined &&
    body.notificationRules     === undefined &&
    body.motiveSettings        === undefined
  ) {
    return c.json({ error: "validation_failed", errors: ["at least one settable field required"] } satisfies ApiErrorResponse, 400);
  }

  // Validate documentTypes before touching the DB. Server-enforced rules
  // that the client cannot bypass:
  //   - every kind in DOCUMENT_KINDS enum
  //   - no duplicate kinds
  //   - rate_con + invoice must have driverVisible=false (hard policy)
  if (body.documentTypes !== undefined && body.documentTypes !== null) {
    if (!Array.isArray(body.documentTypes)) {
      return c.json({ error: "validation_failed", errors: ["documentTypes must be an array or null"] } satisfies ApiErrorResponse, 400);
    }
    const seen = new Set<string>();
    const errs: string[] = [];
    for (const dt of body.documentTypes) {
      if (!dt || typeof dt !== "object") { errs.push("documentTypes entry must be an object"); continue; }
      if (typeof dt.kind !== "string" || !(DOCUMENT_KINDS as readonly string[]).includes(dt.kind)) {
        errs.push(`documentTypes: unknown kind '${dt.kind}'`);
        continue;
      }
      if (seen.has(dt.kind)) { errs.push(`documentTypes: duplicate kind '${dt.kind}'`); continue; }
      seen.add(dt.kind);
      if (typeof dt.enabled !== "boolean")        errs.push(`documentTypes.${dt.kind}: enabled must be boolean`);
      if (typeof dt.driverVisible !== "boolean")  errs.push(`documentTypes.${dt.kind}: driverVisible must be boolean`);
      if ((DRIVER_HIDDEN_DOC_KINDS as readonly string[]).includes(dt.kind) && dt.driverVisible === true) {
        errs.push(`documentTypes.${dt.kind}: driverVisible is locked to false for this kind`);
      }
    }
    if (errs.length) {
      return c.json({ error: "validation_failed", errors: errs } satisfies ApiErrorResponse, 400);
    }
  }

  // Read existing row first so we can patch the JSONB partially without
  // clobbering keys the caller didn't include.
  const { data: existing } = await supabase
    .from("org_settings")
    .select("show_driver_pay,rate_con_settings,invoice_settings,role_overrides,modules,driver_visible_doc_kinds,document_types,notification_rules,motive_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  const existingRow = existing as {
    show_driver_pay:           boolean;
    rate_con_settings:         RateConSettings        | null;
    invoice_settings:          InvoiceSettings        | null;
    role_overrides:            RoleOverrides          | null;
    modules:                   OrgModuleFlags         | null;
    driver_visible_doc_kinds:  string[]               | null;
    document_types:            DocumentTypeConfig[]   | null;
    notification_rules:        NotificationRules      | null;
    motive_settings:           import("@fleetcal/types").MotiveSettings | null;
  } | null;

  const nextShowDriverPay = body.showDriverPay ?? existingRow?.show_driver_pay ?? false;
  // Each JSONB column patches by spread-merge so the caller can update
  // a single field without re-sending the rest.
  const mergedRateCon: RateConSettings = body.rateConSettings === undefined
    ? (existingRow?.rate_con_settings ?? {})
    : { ...(existingRow?.rate_con_settings ?? {}), ...(body.rateConSettings ?? {}) };
  const mergedInvoice: InvoiceSettings = body.invoiceSettings === undefined
    ? (existingRow?.invoice_settings ?? {})
    : { ...(existingRow?.invoice_settings ?? {}), ...(body.invoiceSettings ?? {}) };
  // roleOverrides is a full REPLACE, not a merge — admins toggling
  // a single cell still send the whole map. Trying to merge per-role
  // dicts would make "remove an override" awkward (you'd have to
  // send a sentinel value).
  const nextRoleOverrides: RoleOverrides = body.roleOverrides === undefined
    ? (existingRow?.role_overrides ?? {})
    : (body.roleOverrides ?? {});
  // Module flags merge — single-toggle PATCH ships e.g. {fuel: false}
  // and the API preserves the rest of the map. Reset to defaults by
  // sending an empty object.
  //
  // Seed the merge base with MVP_LAUNCH_DEFAULTS when there's no
  // existing row OR when an existing row has an empty `{}` modules
  // map. The empty-object case fires for orgs whose row was created
  // by a PATCH that ran BEFORE this seeding logic was deployed —
  // without this check, those orgs would have absent keys for every
  // flag (silently re-enabled per isModuleEnabled semantics) for the
  // lifetime of the row. Curzon's stored 5-flag map has keys, so
  // hits the `existingRow?.modules` branch and merges in unchanged.
  const existingStored   = existingRow?.modules ?? null;
  const hasExistingFlags = existingStored !== null && Object.keys(existingStored).length > 0;
  const moduleMergeBase: OrgModuleFlags = hasExistingFlags
    ? existingStored!
    : MVP_LAUNCH_DEFAULTS;
  const mergedModules: OrgModuleFlags = body.orgModules === undefined
    ? moduleMergeBase
    : { ...moduleMergeBase, ...body.orgModules };
  // driverVisibleDocKinds is a full REPLACE — kept for backwards-compat
  // with older clients. New clients should send documentTypes instead.
  const nextDriverVisibleDocKinds: string[] | null =
    body.driverVisibleDocKinds === undefined
      ? (existingRow?.driver_visible_doc_kinds ?? null)
      : (body.driverVisibleDocKinds ?? null);
  // documentTypes is a full REPLACE. If both documentTypes and the
  // legacy driverVisibleDocKinds are sent, documentTypes wins (more
  // expressive). When only documentTypes is sent we also synthesize
  // the legacy field so any reader still on it stays consistent until
  // the next migration drops the column.
  let nextDocumentTypes: DocumentTypeConfig[] | null =
    body.documentTypes === undefined
      ? (existingRow?.document_types ?? null)
      : (body.documentTypes ?? null);
  // Backfill driver_visible_doc_kinds from document_types when it
  // changed and the caller didn't explicitly set the legacy field.
  let syncedDriverVisibleDocKinds = nextDriverVisibleDocKinds;
  if (body.documentTypes !== undefined && body.driverVisibleDocKinds === undefined && nextDocumentTypes) {
    syncedDriverVisibleDocKinds = nextDocumentTypes
      .filter(t => t.enabled && t.driverVisible)
      .map(t => t.kind);
  }
  // notificationRules is also full REPLACE — admin saves the whole
  // shape from the UI; null resets to server defaults.
  const nextNotificationRules: NotificationRules | null =
    body.notificationRules === undefined
      ? (existingRow?.notification_rules ?? null)
      : (body.notificationRules ?? null);
  // Motive + fuel JSONB blocks merge by spread so a single-field
  // PATCH ({motiveSettings: {odometerSyncIntervalHours: 4}}) keeps
  // the rest of the block intact. Send null to clear the whole
  // block.
  const mergedMotive: import("@fleetcal/types").MotiveSettings | null =
    body.motiveSettings === undefined
      ? (existingRow?.motive_settings ?? null)
      : body.motiveSettings === null
        ? null
        : { ...(existingRow?.motive_settings ?? {}), ...body.motiveSettings };

  const { error } = await supabase
    .from("org_settings")
    .upsert(
      {
        org_id:                    orgId,
        show_driver_pay:           nextShowDriverPay,
        rate_con_settings:         mergedRateCon as never,
        invoice_settings:          mergedInvoice as never,
        role_overrides:            nextRoleOverrides as never,
        modules:                   mergedModules as never,
        driver_visible_doc_kinds:  syncedDriverVisibleDocKinds as never,
        document_types:            nextDocumentTypes as never,
        notification_rules:        nextNotificationRules as never,
        motive_settings:           mergedMotive as never,
      } as never,
      { onConflict: "org_id" },
    );
  if (error) {
    console.error("[PATCH /v1/org-settings] failed:", error);
    return c.json({ error: "upsert_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  // Bust the in-memory caches so the new values take effect on the
  // very next request, not after the TTL.
  if (body.roleOverrides !== undefined) {
    invalidateRoleOverrides(orgId);
  }
  if (body.orgModules !== undefined) {
    invalidateOrgModules(orgId);
  }
  const res: UpdateOrgSettingsResponse = {
    settings: {
      showDriverPay:         nextShowDriverPay,
      rateConSettings:       mergedRateCon,
      invoiceSettings:       mergedInvoice,
      roleOverrides:         nextRoleOverrides,
      orgModules:            mergedModules,
      driverVisibleDocKinds: syncedDriverVisibleDocKinds,
      documentTypes:         nextDocumentTypes,
      notificationRules:     nextNotificationRules,
      motiveSettings:        mergedMotive,
    },
  };
  return c.json(res);
});

export default orgSettings;
