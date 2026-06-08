/**
 * GET /api/admin/ai-usage?ym=2026-06
 *
 * Cross-org AI usage aggregates for the /admin/ai-usage dashboard.
 * Returns the monthly rollup rows (one per org × endpoint), recent
 * failures (last 24h, capped at 50), and a KPI summary for the
 * selected month. Org names are resolved from Clerk on the fly with
 * an in-process cache so we don't hammer the Clerk API on every
 * dashboard refresh.
 *
 * Auth: super-admin allowlist (lib/superAdmin.ts). Anyone not on
 * the list gets a 404 — we don't telegraph that the route exists.
 */

import { auth, clerkClient } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isSuperAdmin } from '@/lib/superAdmin';

interface MonthlyRow {
  org_id:        string;
  ym:            string;
  endpoint:      string;
  call_count:    number;
  input_tokens:  number;
  output_tokens: number;
  cost_usd:      string;          // numeric → string from PostgREST
  flagged_at:    string | null;
  first_seen_at: string;
  last_seen_at:  string;
}

interface FailureRow {
  id:          number;
  org_id:      string | null;
  user_id:     string | null;
  endpoint:    string;
  model:       string;
  pass:        number;
  error_code:  string | null;
  latency_ms:  number | null;
  created_at:  string;
}

// ── Org-name cache ────────────────────────────────────────────────
// Clerk's organizations.getOrganization is rate-limited; caching
// 15 minutes lets the dashboard auto-refresh without re-querying.
// LRU isn't worth it at this scale — we expect O(orgs) entries.
const ORG_NAME_TTL_MS = 15 * 60 * 1000;
const orgNameCache = new Map<string, { name: string | null; expiresAt: number }>();

async function resolveOrgName(orgId: string): Promise<string | null> {
  const cached = orgNameCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    const name = org.name ?? null;
    orgNameCache.set(orgId, { name, expiresAt: Date.now() + ORG_NAME_TTL_MS });
    return name;
  } catch (err) {
    // Likely a deleted org or Clerk transient — cache the null so we
    // don't retry every render, but use a shorter TTL so a real
    // outage doesn't wedge us.
    console.warn('[admin/ai-usage] org lookup failed:', orgId, err);
    orgNameCache.set(orgId, { name: null, expiresAt: Date.now() + 60_000 });
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    // 404, not 403 — never reveal the route exists to non-admins.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Default to the current UTC month — matches what the
  // ai_usage_logs trigger writes into ai_usage_monthly.ym.
  const url = new URL(req.url);
  const ym = url.searchParams.get('ym') ?? new Date().toISOString().slice(0, 7);
  // Sanity-check the input: YYYY-MM only. Anything else falls back
  // to current month so a malformed URL can't error the dashboard.
  const safeYm = /^\d{4}-\d{2}$/.test(ym) ? ym : new Date().toISOString().slice(0, 7);

  const db = getSupabaseServer();

  // ── Monthly rollup for selected month ─────────────────────────
  const monthlyRes = await db
    .from('ai_usage_monthly')
    .select('*')
    .eq('ym', safeYm)
    .order('cost_usd', { ascending: false });
  if (monthlyRes.error) {
    console.error('[admin/ai-usage] monthly query failed:', monthlyRes.error.message);
    return NextResponse.json({ error: monthlyRes.error.message }, { status: 500 });
  }
  const monthly: MonthlyRow[] = (monthlyRes.data ?? []) as MonthlyRow[];

  // ── Recent failures (last 24h, any month) ─────────────────────
  // Independent of `safeYm` so the failures view is always
  // "what's broken right now" regardless of which month the user
  // is looking at above.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const failuresRes = await db
    .from('ai_usage_logs')
    .select('id, org_id, user_id, endpoint, model, pass, error_code, latency_ms, created_at')
    .eq('success', false)
    .gte('created_at', yesterday)
    .order('id', { ascending: false })
    .limit(50);
  if (failuresRes.error) {
    console.error('[admin/ai-usage] failures query failed:', failuresRes.error.message);
    return NextResponse.json({ error: failuresRes.error.message }, { status: 500 });
  }
  const failures: FailureRow[] = (failuresRes.data ?? []) as FailureRow[];

  // ── Resolve org names ─────────────────────────────────────────
  // Two passes: collect every distinct org_id we'll surface, then
  // resolve them in parallel through the cache. Empty/null org_ids
  // (system rows) skip the lookup.
  const orgIds = new Set<string>();
  for (const r of monthly) orgIds.add(r.org_id);
  for (const f of failures) if (f.org_id) orgIds.add(f.org_id);
  const orgNameEntries = await Promise.all(
    Array.from(orgIds).map(async id => [id, await resolveOrgName(id)] as const)
  );
  const orgNames: Record<string, string | null> = Object.fromEntries(orgNameEntries);

  // ── KPI summary for the header strip ──────────────────────────
  // Aggregate across all endpoints for the month so the user sees
  // ONE headline number per metric. Per-endpoint breakdown lives
  // inside the table below.
  let totalCalls    = 0;
  let totalInput    = 0;
  let totalOutput   = 0;
  let totalCostUsd  = 0;
  const orgCostTotals = new Map<string, number>();
  for (const r of monthly) {
    totalCalls   += r.call_count;
    totalInput   += r.input_tokens;
    totalOutput  += r.output_tokens;
    const cost = parseFloat(r.cost_usd);
    totalCostUsd += cost;
    orgCostTotals.set(r.org_id, (orgCostTotals.get(r.org_id) ?? 0) + cost);
  }
  const topOrgEntry = Array.from(orgCostTotals.entries())
    .sort((a, b) => b[1] - a[1])[0];

  // Error rate is over LAST 24H, not the selected month — failures
  // are the "right now" signal so charting them by month would
  // hide a fresh outage that started today.
  const recentLogsRes = await db
    .from('ai_usage_logs')
    .select('success', { count: 'exact', head: false })
    .gte('created_at', yesterday);
  let errorRate = 0;
  let recentTotal = 0;
  let recentFailures = 0;
  if (!recentLogsRes.error && recentLogsRes.data) {
    recentTotal = recentLogsRes.data.length;
    recentFailures = recentLogsRes.data.filter((r: { success: boolean }) => !r.success).length;
    errorRate = recentTotal === 0 ? 0 : recentFailures / recentTotal;
  }

  return NextResponse.json({
    ym: safeYm,
    summary: {
      totalCalls,
      totalInputTokens:  totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd,
      topOrg: topOrgEntry
        ? { orgId: topOrgEntry[0], name: orgNames[topOrgEntry[0]] ?? null, costUsd: topOrgEntry[1] }
        : null,
      recentTotal,
      recentFailures,
      errorRate,
    },
    monthly: monthly.map(r => ({
      ...r,
      cost_usd: parseFloat(r.cost_usd),
      org_name: orgNames[r.org_id] ?? null,
    })),
    failures: failures.map(f => ({
      ...f,
      org_name: f.org_id ? (orgNames[f.org_id] ?? null) : null,
    })),
  });
}
