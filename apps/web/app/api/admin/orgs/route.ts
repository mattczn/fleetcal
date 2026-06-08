/**
 * GET /api/admin/orgs
 *
 * Cross-org activity dashboard for /admin/orgs. Pulls per-org
 * activity signals from existing tables so we can spot:
 *
 *   - "Active and growing" customers (frequent logins, growing
 *     load count)
 *   - "Idle risk" customers (no activity in 14+ days)
 *   - "Onboarding stuck" orgs (signed up, never created a load)
 *
 * Joins everything in memory because the org count is tiny
 * (<100s for years to come) and PostgREST lacks a clean way to
 * group across tables without writing a stored procedure.
 *
 * Super-admin gated. Non-admins get a 404.
 */

import { auth, clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isSuperAdmin } from '@/lib/superAdmin';

interface LoadRow {
  org_id:        string;
  total_billable: string | null;
  created_at:    string;
  verified_at:   string | null;
}

// Org-name cache — Clerk org listing can paginate, so we cache
// 15min and refresh on first hit only.
const ORG_TTL_MS = 15 * 60 * 1000;
let orgCache: { fetchedAt: number; orgs: Array<{ id: string; name: string; createdAt: number; membersCount: number }> } | null = null;

async function listAllOrgs() {
  if (orgCache && Date.now() - orgCache.fetchedAt < ORG_TTL_MS) {
    return orgCache.orgs;
  }
  const client = await clerkClient();
  const all: Array<{ id: string; name: string; createdAt: number; membersCount: number }> = [];
  let offset = 0;
  const limit = 100;
  // Cap at 1000 orgs — comically far above where we'll be for
  // years. Prevents an infinite loop if Clerk's pagination breaks.
  while (offset < 1000) {
    const page = await client.organizations.getOrganizationList({ limit, offset });
    for (const o of page.data) {
      all.push({
        id:           o.id,
        name:         o.name,
        createdAt:    o.createdAt,
        membersCount: o.membersCount ?? 0,
      });
    }
    if (page.data.length < limit) break;
    offset += limit;
  }
  orgCache = { fetchedAt: Date.now(), orgs: all };
  return all;
}

export async function GET() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = getSupabaseServer();

  // ── Loads, last 30 days ───────────────────────────────────────
  // Drives "loads created 30d", revenue volume, and last-load
  // activity per org. We pull recent only so the join cost stays
  // bounded; a full historical view lives in the per-org detail
  // page that we'll add later.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const loadsRes = await db
    .from('loads')
    .select('org_id, total_billable, created_at, verified_at')
    .gte('created_at', thirtyDaysAgo)
    .limit(5000);
  if (loadsRes.error) {
    console.error('[admin/orgs] loads query failed:', loadsRes.error.message);
    return NextResponse.json({ error: loadsRes.error.message }, { status: 500 });
  }
  const loads = (loadsRes.data ?? []) as LoadRow[];

  // ── Group by org_id ───────────────────────────────────────────
  interface OrgStats {
    loadsCreated30d:   number;
    loadsVerified30d:  number;  // released for billing (Paperwork → Released)
    revenue30d:        number;
    lastLoadCreated:   string | null;
  }
  const stats = new Map<string, OrgStats>();
  for (const l of loads) {
    const cur = stats.get(l.org_id) ?? {
      loadsCreated30d:  0,
      loadsVerified30d: 0,
      revenue30d:       0,
      lastLoadCreated:  null,
    };
    cur.loadsCreated30d++;
    if (l.verified_at) cur.loadsVerified30d++;
    const tb = parseFloat(l.total_billable ?? '0');
    if (Number.isFinite(tb)) cur.revenue30d += tb;
    if (!cur.lastLoadCreated || l.created_at > cur.lastLoadCreated) {
      cur.lastLoadCreated = l.created_at;
    }
    stats.set(l.org_id, cur);
  }

  // ── Clerk orgs ────────────────────────────────────────────────
  // Pull EVERY org, not just ones with recent loads — so the
  // dashboard can flag "signed up, never created a load" orgs.
  let orgs: Awaited<ReturnType<typeof listAllOrgs>> = [];
  try {
    orgs = await listAllOrgs();
  } catch (err) {
    console.warn('[admin/orgs] Clerk org list failed; falling back to org_ids from loads:', err);
    const seen = new Set(loads.map(l => l.org_id));
    orgs = Array.from(seen).map(id => ({ id, name: id, createdAt: 0, membersCount: 0 }));
  }

  // ── Build rows ────────────────────────────────────────────────
  const now = Date.now();
  const rows = orgs.map(o => {
    const s = stats.get(o.id) ?? { loadsCreated30d: 0, loadsVerified30d: 0, revenue30d: 0, lastLoadCreated: null };
    const lastActivityMs = s.lastLoadCreated ? new Date(s.lastLoadCreated).getTime() : 0;
    const ageDays        = lastActivityMs ? Math.floor((now - lastActivityMs) / 86_400_000) : null;
    // Risk flag:
    //   - 'never_activated': org > 7d old + 0 loads ever (in the 30d
    //      window; an old org with old loads wouldn't trigger this
    //      because we only see recent activity).
    //   - 'idle':            had loads but last activity > 14d ago.
    //   - 'churning':        last activity > 30d ago AND total loads
    //                        in window = 0.
    //   - null:              healthy or too-new.
    let flag: 'never_activated' | 'idle' | 'churning' | null = null;
    if (s.loadsCreated30d === 0) {
      const orgAgeDays = o.createdAt ? Math.floor((now - o.createdAt) / 86_400_000) : null;
      if (orgAgeDays != null && orgAgeDays >= 30) flag = 'churning';
      else if (orgAgeDays != null && orgAgeDays >= 7) flag = 'never_activated';
    } else if (ageDays != null && ageDays > 14) {
      flag = 'idle';
    }
    return {
      orgId:             o.id,
      orgName:           o.name,
      createdAt:         o.createdAt,
      membersCount:      o.membersCount,
      loadsCreated30d:   s.loadsCreated30d,
      loadsVerified30d:  s.loadsVerified30d,
      revenue30d:        s.revenue30d,
      lastLoadCreated:   s.lastLoadCreated,
      ageDaysSinceLastLoad: ageDays,
      flag,
    };
  });

  // Sort by load volume desc — most-active first.
  rows.sort((a, b) => b.loadsCreated30d - a.loadsCreated30d);

  // ── Summary ───────────────────────────────────────────────────
  const summary = {
    totalOrgs:        rows.length,
    activeOrgs:       rows.filter(r => r.loadsCreated30d > 0).length,
    flaggedOrgs:     rows.filter(r => r.flag !== null).length,
    totalLoads30d:    rows.reduce((s, r) => s + r.loadsCreated30d, 0),
    totalRevenue30d:  rows.reduce((s, r) => s + r.revenue30d, 0),
  };

  return NextResponse.json({ summary, orgs: rows });
}
