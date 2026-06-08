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
