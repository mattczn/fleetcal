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

interface TruckRow {
  org_id: string;
}

// Feature-flag → tier-label mapping. Mirrors useOrgTier on the
// client. Resolution order is highest → lowest so an org with
// multiple flags lands on the most-permissive tier.
const TIER_PRIORITY: Array<{ feature: string; tier: 'fleet' | 'growth' | 'owner_op'; label: string }> = [
  { feature: 'fleet_tier',    tier: 'fleet',    label: 'Fleet'    },
  { feature: 'growth_tier',   tier: 'growth',   label: 'Growth'   },
  { feature: 'owner_op_tier', tier: 'owner_op', label: 'Owner Op' },
];

type TierKey = 'fleet' | 'growth' | 'owner_op' | 'none';
type PlanPeriod = 'month' | 'annual' | null;

interface OrgTierInfo {
  tier:        TierKey;
  tierLabel:   string;
  planPeriod:  PlanPeriod;
  /** Subscription status verbatim from Clerk — 'active' | 'past_due' | etc. */
  status:      string | null;
}

async function fetchTierForOrg(client: Awaited<ReturnType<typeof clerkClient>>, orgId: string): Promise<OrgTierInfo> {
  // Clerk's billing API is marked @experimental; wrap in try so a
  // beta change can't break the whole dashboard. Orgs without a
  // subscription (Curzon + grandfathered) throw a 404 → 'none'.
  try {
    const sub = await client.billing.getOrganizationBillingSubscription(orgId);
    // A subscription may have multiple items if the org somehow
    // ended up on overlapping plans. Pick the highest-priority
    // tier across all items.
    let best: OrgTierInfo = { tier: 'none', tierLabel: '—', planPeriod: null, status: sub.status ?? null };
    for (const item of sub.subscriptionItems) {
      const features = item.plan?.features ?? [];
      for (const slot of TIER_PRIORITY) {
        if (features.some(f => f.slug === slot.feature)) {
          if (best.tier === 'none' || priorityRank(slot.tier) > priorityRank(best.tier)) {
            best = {
              tier:       slot.tier,
              tierLabel:  slot.label,
              planPeriod: item.planPeriod ?? null,
              status:     sub.status ?? null,
            };
          }
          break;
        }
      }
    }
    return best;
  } catch {
    return { tier: 'none', tierLabel: '—', planPeriod: null, status: null };
  }
}

function priorityRank(tier: TierKey): number {
  if (tier === 'fleet')    return 3;
  if (tier === 'growth')   return 2;
  if (tier === 'owner_op') return 1;
  return 0;
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

  // ── Loads + active trucks, in parallel ────────────────────────
  // Loads drive the 30d activity columns. Trucks are a cross-org
  // count of every non-hidden asset row — this is the same "active
  // truck" definition the billing cap enforces (see useOrgTier).
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [loadsRes, trucksRes] = await Promise.all([
    db.from('loads')
      .select('org_id, total_billable, created_at, verified_at')
      .gte('created_at', thirtyDaysAgo)
      .limit(5000),
    db.from('assets')
      .select('org_id')
      .eq('hidden', false)
      .limit(50_000),
  ]);
  if (loadsRes.error) {
    console.error('[admin/orgs] loads query failed:', loadsRes.error.message);
    return NextResponse.json({ error: loadsRes.error.message }, { status: 500 });
  }
  if (trucksRes.error) {
    console.warn('[admin/orgs] trucks query failed, continuing without:', trucksRes.error.message);
  }
  const loads  = (loadsRes.data  ?? []) as LoadRow[];
  const trucks = (trucksRes.data ?? []) as TruckRow[];
  const truckCountByOrg = new Map<string, number>();
  for (const t of trucks) {
    truckCountByOrg.set(t.org_id, (truckCountByOrg.get(t.org_id) ?? 0) + 1);
  }

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
  const client = await clerkClient();
  let orgs: Awaited<ReturnType<typeof listAllOrgs>> = [];
  try {
    orgs = await listAllOrgs();
  } catch (err) {
    console.warn('[admin/orgs] Clerk org list failed; falling back to org_ids from loads:', err);
    const seen = new Set(loads.map(l => l.org_id));
    orgs = Array.from(seen).map(id => ({ id, name: id, createdAt: 0, membersCount: 0 }));
  }

  // ── Subscription tier per org ────────────────────────────────
  // Fans out one billing-subscription read per org in parallel.
  // Clerk's billing API caps roughly at hundreds of requests per
  // second per backend key, so we're fine into the low thousands
  // of orgs. If this gets slow later, we can cache per-org tier
  // for ~15 minutes alongside the org list cache above.
  const tierByOrg = new Map<string, OrgTierInfo>();
  const tierResults = await Promise.allSettled(
    orgs.map(o => fetchTierForOrg(client, o.id).then(info => [o.id, info] as const))
  );
  for (const r of tierResults) {
    if (r.status === 'fulfilled') {
      tierByOrg.set(r.value[0], r.value[1]);
    }
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
    const tierInfo = tierByOrg.get(o.id) ?? { tier: 'none' as TierKey, tierLabel: '—', planPeriod: null as PlanPeriod, status: null };
    return {
      orgId:             o.id,
      orgName:           o.name,
      createdAt:         o.createdAt,
      membersCount:      o.membersCount,
      truckCount:        truckCountByOrg.get(o.id) ?? 0,
      tier:              tierInfo.tier,
      tierLabel:         tierInfo.tierLabel,
      planPeriod:        tierInfo.planPeriod,
      subscriptionStatus: tierInfo.status,
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
