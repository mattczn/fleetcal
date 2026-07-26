/**
 * GET / PATCH /api/admin/orgs/:orgId/modules
 *
 * Cross-org module control for the super-admin portal. This is the
 * surface that replaces "SSH in and run an UPDATE on org_settings"
 * when a carrier buys an add-on or asks for a feature to be turned
 * off.
 *
 * Why it lives here and not in apps/api: Settings → Modules already
 * exists, but it edits the CALLER'S OWN org (requireCapability
 * 'org.settings.edit' against the JWT's org_id) and its nav entry is
 * hard-gated to internal orgs. Neither is usable for managing a
 * customer you're not a member of. This route is org-agnostic and
 * gated on the deploy-controlled SUPER_ADMIN_USER_IDS allowlist
 * instead, matching the rest of /api/admin/*.
 *
 * Cache note: apps/api caches each org's module map in-process for
 * ORG_MODULES_TTL_MS (60s, see apps/api/src/middleware/require.ts).
 * A write here bypasses that cache's invalidation hook, so a change
 * takes effect on the API within a minute rather than instantly. The
 * web client picks it up on the org's next /v1/org-settings fetch.
 * The UI states this; don't "fix" it by reaching into the API's
 * memory from another service.
 *
 * Non-admins get a 404, not a 403 — same as every other admin route,
 * so probing can't confirm the surface exists.
 */

import { auth, clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import {
  DEFAULT_OFF_MODULES,
  resolveOrgModules,
  ORG_MODULES,
  type OrgModule,
} from '@fleetcal/types';
import type { OrgModuleFlags } from '@fleetcal/types';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isSuperAdmin } from '@/lib/superAdmin';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

const MODULE_SET: ReadonlySet<string> = new Set(ORG_MODULES);

// Resolution comes from @fleetcal/types so the admin portal can't drift
// from what the API enforces — this file used to carry its own copy of
// the spread, which is precisely how the nav and the route guard ended
// up disagreeing. See resolveOrgModules.

async function loadOrgName(orgId: string): Promise<string | null> {
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    return org.name;
  } catch {
    return null;
  }
}

// ── GET ────────────────────────────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) return notFound();

  const { orgId } = await params;

  // Resolve the org through Clerk first. Doubles as existence
  // validation — a typo'd org_id would otherwise return a page of
  // pure defaults that looks like a real (if untouched) org.
  const orgName = await loadOrgName(orgId);
  if (!orgName) return notFound();

  const db = getSupabaseServer();
  const { data, error } = await db
    .from('org_settings')
    .select('modules')
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    console.error(`[admin/orgs/${orgId}/modules] read failed:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const stored = (data?.modules ?? null) as OrgModuleFlags | null;

  return NextResponse.json({
    orgId,
    orgName,
    /** Effective flags after layering — what the API will enforce. */
    modules: resolveOrgModules(stored),
    /** Only the keys this org has explicitly opined on. Everything
     *  else in `modules` is inherited, and will keep tracking the
     *  launch default if we change it in code. */
    storedOverrides: stored ?? {},
    /** Modules that must never be enabled for a customer org. The UI
     *  renders these behind a confirmation. */
    internalOnly: Array.from(DEFAULT_OFF_MODULES),
  });
}

// ── PATCH ──────────────────────────────────────────────────────────

interface PatchBody {
  /** Sparse map — only the modules being changed. Merged over the
   *  org's current effective flags. */
  modules?: Record<string, boolean>;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) return notFound();

  const { orgId } = await params;

  let body: PatchBody;
  try {
    body = await req.json() as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const incoming = body.modules;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return NextResponse.json({ error: 'Body must be { modules: { [module]: boolean } }' }, { status: 400 });
  }

  // Reject unknown keys outright. `modules` is a free-form JSONB
  // column and OrgModuleFlags is Partial<Record<string, boolean>>, so
  // nothing downstream would stop a typo'd key ("expense") from being
  // written and silently never read — leaving the real module on its
  // default while the admin believes they changed it.
  const unknown = Object.keys(incoming).filter(k => !MODULE_SET.has(k));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown module(s): ${unknown.join(', ')}` },
      { status: 400 },
    );
  }
  const nonBool = Object.entries(incoming).filter(([, v]) => typeof v !== 'boolean');
  if (nonBool.length > 0) {
    return NextResponse.json(
      { error: `Module values must be boolean: ${nonBool.map(([k]) => k).join(', ')}` },
      { status: 400 },
    );
  }

  const orgName = await loadOrgName(orgId);
  if (!orgName) return notFound();

  const db = getSupabaseServer();
  const { data: existing, error: readErr } = await db
    .from('org_settings')
    .select('org_id, modules')
    .eq('org_id', orgId)
    .maybeSingle();

  if (readErr) {
    console.error(`[admin/orgs/${orgId}/modules] read-before-write failed:`, readErr.message);
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }

  const stored = (existing?.modules ?? null) as OrgModuleFlags | null;
  const merged = { ...resolveOrgModules(stored), ...incoming };

  // Update-or-insert rather than upsert: this route writes ONE column
  // of a wide row, and an explicit update can't be misread as
  // clobbering the rest of org_settings.
  if (existing) {
    const { error } = await db
      .from('org_settings')
      .update({ modules: merged } as never)
      .eq('org_id', orgId);
    if (error) {
      console.error(`[admin/orgs/${orgId}/modules] update failed:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  } else {
    const { error } = await db
      .from('org_settings')
      .insert({ org_id: orgId, modules: merged } as never);
    if (error) {
      console.error(`[admin/orgs/${orgId}/modules] insert failed:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // Audit trail lands in the platform logs — there's no cross-org
  // audit_log table, and per-org audit_log rows are the customer's
  // record of their own actions, not ours.
  const changed = Object.entries(incoming)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.info(`[admin] ${userId} set modules for ${orgId} (${orgName}): ${changed}`);

  return NextResponse.json({
    orgId,
    orgName,
    modules: merged as Record<OrgModule, boolean>,
    storedOverrides: merged,
  });
}
