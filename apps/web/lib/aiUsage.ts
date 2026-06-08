/**
 * Anthropic call wrapper that persists per-call usage to
 * ai_usage_logs without blocking the user response.
 *
 * Why a wrapper:
 *   - Capturing usage requires reading `response.usage` after each
 *     Anthropic call. Doing it inline at every call site means six
 *     places to update when the rate card changes, six places to
 *     remember to handle pre-flight failures, etc. One helper.
 *   - Logging is FIRE-AND-FORGET on purpose. The user's parse
 *     latency must not depend on Supabase being reachable. A
 *     failed insert logs to console but never throws.
 *   - The trigger on ai_usage_logs maintains the monthly rollup,
 *     so this helper writes exactly one row per Anthropic call
 *     even when the row contributes to two destinations.
 *
 * Usage:
 *
 *   const usage = makeUsageTracker({
 *     orgId, userId, endpoint: 'parse-ratecon', requestBytes,
 *   });
 *
 *   try {
 *     const res = await client.messages.create({ model, ... });
 *     usage.recordSuccess({ model, pass: 1, response: res, latencyMs });
 *     // ...
 *   } catch (err) {
 *     usage.recordFailure({ model, pass: 1, errorCode: 'anthropic_5xx', latencyMs });
 *     throw err;
 *   }
 *
 * Pre-flight gates (rate limit hit, monthly cap exceeded, invalid
 * input) also call `recordFailure` with the appropriate errorCode
 * so the dashboard can chart denied requests separately — those
 * never billed Anthropic but they're still signal.
 */

import { getSupabaseServer } from './supabase-server';
import { costFor, type AnthropicUsage } from './aiPricing';

// ─── Pre-flight gates ─────────────────────────────────────────────
//
// Two layers of protection sit BEFORE the Anthropic call so a
// runaway loop (or scripted abuse) costs us nothing:
//
//   1. Monthly cap (DB-backed). Reads ai_usage_monthly's denormalized
//      cost_usd for (orgId, current ym, 'parse-ratecon'). If the
//      org's running total is at or past the cap, return 402. The
//      cap is read from org_settings.ai_monthly_cap_usd, falling
//      back to DEFAULT_MONTHLY_CAP_USD when null.
//
//   2. Per-minute rate limit (in-memory sliding window). Caps each
//      org at MAX_CALLS_PER_MINUTE within a rolling 60s window.
//      Catches scripted bursts that don't yet hit the monthly cap.
//      In-memory works because apps/web on Vercel uses serverless
//      functions that DON'T share state — each invocation has its
//      own Map. The trade-off: a script hitting the API from many
//      concurrent function instances could in theory exceed the
//      limit; in practice the per-instance cap of 20/min is plenty
//      tight to catch any real abuse, and the monthly cap is the
//      real backstop.

/**
 * Default monthly cap when org_settings.ai_monthly_cap_usd is NULL.
 * $25 covers ~1,250 typical Haiku-only parses or ~500 mixed
 * Haiku+Sonnet escalations — well above any honest user, well
 * below "someone left a script running overnight" territory.
 */
export const DEFAULT_MONTHLY_CAP_USD = 25;

/**
 * Per-minute call ceiling per (org, endpoint) inside ONE serverless
 * function instance. Each invocation has its own Map, so the actual
 * cluster-wide ceiling is multiplied by the parallelism factor —
 * deliberately not configurable from outside this module to avoid
 * accidentally setting it to "1" and breaking the whole feature.
 */
const MAX_CALLS_PER_MINUTE = 20;
const RATE_WINDOW_MS       = 60_000;

// Map<`${orgId}:${endpoint}`, timestamps[]>. Timestamps older than
// RATE_WINDOW_MS get pruned on each check.
const rateBuckets = new Map<string, number[]>();

export type GateResult =
  | { ok: true }
  | {
      ok: false;
      /** HTTP status to return. */
      status: number;
      /** error_code value for ai_usage_logs grouping. */
      code: 'monthly_cap_exceeded' | 'rate_limit_org_minute';
      /** User-friendly message. */
      message: string;
    };

interface PreflightArgs {
  orgId:    string;
  endpoint: string;
}

/**
 * Run BOTH pre-flight gates. Call this from the route AFTER auth
 * but BEFORE the Anthropic call. Returns `{ok: true}` to proceed,
 * or `{ok: false, …}` with a status + message to return to the user.
 *
 * The route is responsible for surfacing the denial via the usage
 * tracker (`recordFailure` with the matching `code`) so the
 * dashboard's error-rate breakdown stays honest.
 */
export async function preflightCheck({ orgId, endpoint }: PreflightArgs): Promise<GateResult> {
  // Rate limit first — cheaper, no DB hit.
  const rate = checkRateLimit(orgId, endpoint);
  if (!rate.ok) return rate;

  // Monthly cap.
  const cap = await checkMonthlyCap(orgId, endpoint);
  if (!cap.ok) return cap;

  return { ok: true };
}

function checkRateLimit(orgId: string, endpoint: string): GateResult {
  const key = `${orgId}:${endpoint}`;
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const arr = (rateBuckets.get(key) ?? []).filter(t => t > cutoff);
  if (arr.length >= MAX_CALLS_PER_MINUTE) {
    return {
      ok:      false,
      status:  429,
      code:    'rate_limit_org_minute',
      message: `Too many AI calls in the last minute. Please wait a few seconds before trying again.`,
    };
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return { ok: true };
}

async function checkMonthlyCap(orgId: string, endpoint: string): Promise<GateResult> {
  try {
    const db = getSupabaseServer();
    const ym = new Date().toISOString().slice(0, 7);

    // Two reads in parallel: the org's override cap + the running
    // total for this month. Each is <1 row by primary-key lookup.
    const [settingsRes, monthlyRes] = await Promise.all([
      db.from('org_settings')
        .select('ai_monthly_cap_usd')
        .eq('org_id', orgId)
        .maybeSingle(),
      db.from('ai_usage_monthly')
        .select('cost_usd')
        .eq('org_id', orgId)
        .eq('ym', ym)
        .eq('endpoint', endpoint)
        .maybeSingle(),
    ]);

    const overrideCap = (settingsRes.data as { ai_monthly_cap_usd: string | null } | null)?.ai_monthly_cap_usd;
    const cap = overrideCap != null ? parseFloat(overrideCap) : DEFAULT_MONTHLY_CAP_USD;

    const spent = (monthlyRes.data as { cost_usd: string } | null)?.cost_usd;
    const spentUsd = spent != null ? parseFloat(spent) : 0;

    if (spentUsd >= cap) {
      return {
        ok:      false,
        status:  402,
        code:    'monthly_cap_exceeded',
        message: `Monthly AI budget reached ($${cap.toFixed(2)}). The cap resets at the start of next month — contact support to raise it sooner.`,
      };
    }
  } catch (err) {
    // Fail OPEN on DB errors. A wedged Supabase shouldn't block
    // every parse in the system. The Anthropic spend is bounded by
    // the rate limit above, so worst case is a brief window where
    // an over-cap org sneaks a few calls through.
    console.warn('[aiUsage] cap check failed open:', err);
  }
  return { ok: true };
}

export interface UsageContext {
  /** Clerk org id. Null is allowed (system-level call) but the row
   *  won't roll up into ai_usage_monthly — the trigger skips
   *  org_id IS NULL. */
  orgId:        string | null;
  /** Clerk user id, if known. */
  userId:       string | null;
  /** Logical endpoint name. NOT the URL path — same value across
   *  every Anthropic call inside one route (parse-ratecon's pass 1
   *  + pass 2 both report 'parse-ratecon'). Distinct features get
   *  distinct names so the dashboard breakdown is meaningful. */
  endpoint:     string;
  /** Size of the inbound request to OUR route — bytes of PDF for
   *  parse-ratecon, bytes of the JSON body for everything else.
   *  Optional; recorded for forensics ("user uploaded a 50-page
   *  rate-con"). */
  requestBytes?: number;
}

export interface RecordSuccessArgs {
  model:     string;
  pass:      number;
  response:  { usage?: AnthropicUsage };
  latencyMs: number;
}

export interface RecordFailureArgs {
  model:     string;
  pass:      number;
  /** Short stable tag. Examples: 'anthropic_5xx', 'json_parse_fail',
   *  'rate_limit_org_minute', 'monthly_cap_exceeded'. The dashboard
   *  groups by this value, so prefer a fixed vocabulary over free
   *  text. */
  errorCode: string;
  latencyMs: number;
  /** Some Anthropic errors arrive AFTER the model started billing
   *  (e.g. response truncated mid-generation). If you have a
   *  partial usage block, pass it here so cost still gets charged
   *  to the org. */
  usage?:    AnthropicUsage;
}

export interface UsageTracker {
  recordSuccess(args: RecordSuccessArgs): void;
  recordFailure(args: RecordFailureArgs): void;
}

export function makeUsageTracker(ctx: UsageContext): UsageTracker {
  return {
    recordSuccess({ model, pass, response, latencyMs }) {
      const usage = response.usage ?? {};
      void writeLog({
        ctx,
        model,
        pass,
        usage,
        latencyMs,
        success: true,
        errorCode: null,
      });
    },
    recordFailure({ model, pass, errorCode, latencyMs, usage }) {
      void writeLog({
        ctx,
        model,
        pass,
        usage: usage ?? {},
        latencyMs,
        success: false,
        errorCode,
      });
    },
  };
}

interface WriteLogArgs {
  ctx:       UsageContext;
  model:     string;
  pass:      number;
  usage:     AnthropicUsage;
  latencyMs: number;
  success:   boolean;
  errorCode: string | null;
}

async function writeLog({
  ctx, model, pass, usage, latencyMs, success, errorCode,
}: WriteLogArgs): Promise<void> {
  try {
    const cost = costFor(model, usage);
    const db = getSupabaseServer();
    const { error } = await db.from('ai_usage_logs').insert({
      org_id:                       ctx.orgId,
      user_id:                      ctx.userId,
      endpoint:                     ctx.endpoint,
      model,
      pass,
      input_tokens:                 usage.input_tokens                ?? null,
      output_tokens:                usage.output_tokens               ?? null,
      cache_creation_input_tokens:  usage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens:      usage.cache_read_input_tokens     ?? null,
      cost_usd:                     cost,
      latency_ms:                   latencyMs,
      request_bytes:                ctx.requestBytes ?? null,
      success,
      error_code:                   errorCode,
    });
    if (error) {
      // Log + swallow — billing telemetry must NEVER block the
      // user's response. A failed insert costs us visibility on
      // ONE call; a thrown error here would break the parse.
      console.error('[aiUsage] insert failed:', error.message, {
        orgId:    ctx.orgId,
        endpoint: ctx.endpoint,
        model,
        pass,
      });
    }
  } catch (err) {
    console.error('[aiUsage] writeLog threw:', err);
  }
}
