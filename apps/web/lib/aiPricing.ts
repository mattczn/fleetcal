/**
 * Anthropic per-model pricing for the AI usage tracking system.
 *
 * Each model's rate is per 1M tokens (Anthropic's billing unit).
 * Source: https://www.anthropic.com/pricing — kept in code, not the
 * DB, so price changes go through review and the diff lands in the
 * commit log next to the model id it affects.
 *
 * `cache_creation` and `cache_read` are separate buckets in the
 * Anthropic response. parse-ratecon caches the PDF block on pass 1
 * so the (conditional) pass 2 reads it at ~10% of normal input
 * rate — that delta only shows up if we cost the cache buckets
 * separately, which we do.
 *
 * `costFor(model, usage)` returns USD as a number. Callers persist
 * the snapshot on each ai_usage_logs row; the value is FROZEN at
 * insert time, so future rate-card changes don't retroactively
 * rewrite history. If we ever want "what would today's prices have
 * cost this org last month", re-cost from token counts using this
 * same function — that's the reason model ids are FULL ids
 * ("claude-haiku-4-5-20251001"), not family names ("haiku").
 */

// Anthropic SDK types most of these as `number | null` (null when the
// response didn't exercise that bucket). Accept null so callers can
// pass `response.usage` straight in without sanitizing first.
export interface AnthropicUsage {
  input_tokens?:                number | null;
  output_tokens?:               number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?:     number | null;
}

/** Rate card per 1M tokens. All fields in USD. */
interface ModelRate {
  input:          number;
  output:         number;
  cacheCreation:  number;
  cacheRead:      number;
}

// ─── Rate cards ────────────────────────────────────────────────────
// Kept newest-first. Update the row + bump the model id when
// Anthropic releases a new snapshot; historical rows keep their
// previously-frozen cost_usd snapshot.
const RATES: Record<string, ModelRate> = {
  // Haiku 4.5 — the parse-ratecon pass-1 default.
  'claude-haiku-4-5-20251001': {
    input:         1.00,
    output:        5.00,
    cacheCreation: 1.25,
    cacheRead:     0.10,
  },
  // Sonnet 4.5 — parse-ratecon pass-2 correction + cost-analysis.
  'claude-sonnet-4-5-20250929': {
    input:         3.00,
    output:       15.00,
    cacheCreation: 3.75,
    cacheRead:     0.30,
  },
  // Opus 4.5 — cost-analysis (high-accuracy mode), timeline auto-link.
  'claude-opus-4-5': {
    input:        15.00,
    output:       75.00,
    cacheCreation:18.75,
    cacheRead:     1.50,
  },
};

/**
 * Compute USD cost for an Anthropic response's usage block.
 *
 * Unknown models return 0 (not NaN) so a deploy that adds a new
 * model id before the rate card update doesn't dirty the log table
 * with NaN values — the row still inserts, the cost is just
 * undercounted until the rate card catches up. The admin dashboard
 * surfaces "unknown model" rows separately so this stays visible.
 */
export function costFor(model: string, usage: AnthropicUsage): number {
  const rate = RATES[model];
  if (!rate) return 0;

  const inTok      = usage.input_tokens                ?? 0;
  const outTok     = usage.output_tokens               ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead   = usage.cache_read_input_tokens     ?? 0;

  // Per-1M conversion. Multiply then divide so floating-point
  // rounding lands at sub-cent precision instead of one big
  // (tokens * dollars / 1e6) where the dollars magnitude can
  // wash out a few-cent contribution.
  const cost =
    (inTok       * rate.input)         / 1_000_000 +
    (outTok      * rate.output)        / 1_000_000 +
    (cacheCreate * rate.cacheCreation) / 1_000_000 +
    (cacheRead   * rate.cacheRead)     / 1_000_000;

  return cost;
}

/** True if we have a rate card for `model`. Used by the dashboard
 *  to badge "unknown model" rows. */
export function knownModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(RATES, model);
}
