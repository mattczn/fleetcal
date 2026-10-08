import type { Customer, CustomerMatchResult } from './types';

/**
 * Resolve a load's broker string to the org's preferred display name.
 * Returns `customer.shortName` when the broker matches a customer record
 * (by canonical name or alias) AND the customer has a shortName set;
 * otherwise returns the raw broker string. Use this everywhere a load's
 * broker is rendered so abbreviations show consistently.
 *
 * The underlying `Load.broker` column always stores the canonical name,
 * so search / fuzzy-match / recovery still work if a shortName is later
 * cleared.
 */
export function displayBrokerName(
  broker: string | null | undefined,
  customers: Customer[],
): string {
  if (!broker) return '';
  const customer = customers.find(c =>
    c.name === broker || c.aliases.includes(broker),
  );
  return customer?.shortName?.trim() || broker;
}

// Words that add no signal when comparing broker names
const STOP_WORDS = new Set([
  'llc', 'inc', 'corp', 'co', 'company', 'ltd', 'limited', 'group', 'international',
  'freight', 'logistics', 'transport', 'transportation', 'trucking', 'carriers',
  'carrier', 'solutions', 'services', 'service', 'systems', 'global', 'national',
  'express', 'direct', 'lines', 'line', 'usa', 'us',
]);

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .join(' ')
    .trim();
}

function wordSet(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Raw comparison key: case and punctuation folded, nothing dropped. */
function rawKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Legal form, which says nothing about WHICH company this is —
 * "Trident Logistics, LLC" on a rate con and "Trident Logistics" in
 * the customer list are the same broker. Dropped only from the end,
 * and only these words: the industry words ("Logistics", "Transport")
 * stay, because those are exactly what distinguishes one Trident from
 * another.
 */
const LEGAL_TAIL = new Set(['llc', 'l l c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'lp', 'llp', 'plc', 'pc']);

function entityKey(s: string): string {
  const words = rawKey(s).split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_TAIL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

function scoreAgainst(extracted: string, candidate: string): number {
  const normEx = normalizeName(extracted);
  const normCand = normalizeName(candidate);

  const rawEx   = rawKey(extracted);
  const rawCand = rawKey(candidate);

  // The WHOLE name matching, industry words and all, is the strongest
  // evidence there is and must outrank a match that only survives
  // because normalizeName threw words away. Curzon carries both
  // "Trident" (Trident Transport) and "Trident Logistics": both
  // normalise to "trident", so an exact-normalised tie had the two
  // indistinguishable and the winner came down to array order. A rate
  // con reading "Trident Logistics" now matches the record of that
  // name outright.
  if (rawEx === rawCand) return 1.0;

  // Same name once the legal form is dropped. Rate cons print "LLC"
  // and customer records usually don't, so this is the common shape
  // of a genuine exact match — and it still outranks a stop-word
  // collapse, which is what keeps "TRIDENT LOGISTICS, LLC" off the
  // "Trident" record.
  if (entityKey(extracted) === entityKey(candidate)) return 0.98;

  // If normalization wiped out one or both names (all stop words), fall back to raw
  if (!normEx || !normCand) {
    if (rawCand.includes(rawEx) || rawEx.includes(rawCand)) return 0.85;
    return 0;
  }

  // Exact match once the industry words are stripped. Strong, but
  // strictly weaker than matching the name as written.
  if (normEx === normCand) return 0.95;

  // One fully contains the other
  if (normCand.includes(normEx) || normEx.includes(normCand)) return 0.9;

  // Jaccard on word sets
  return jaccard(wordSet(normEx), wordSet(normCand)) * 0.95;
}

/**
 * How close the runner-up has to be before the two are treated as
 * indistinguishable. Deliberately tiny: this is for genuine ties, not
 * for "a bit less sure". A margin wide enough to catch near-misses
 * would turn ordinary matches into questions, and a banner people
 * dismiss by reflex protects nobody.
 */
const AMBIGUITY_MARGIN = 0.02;

export function matchCustomer(
  extracted: string,
  customers: Customer[],
): CustomerMatchResult {
  if (!extracted?.trim()) return { status: 'none' };
  if (customers.length === 0) return { status: 'new', extracted: extracted.trim() };

  let best: { customer: Customer; score: number } | null = null;
  let runnerUp: { customer: Customer; score: number } | null = null;

  for (const c of customers) {
    const candidates = [c.name, ...c.aliases];
    const score = Math.max(...candidates.map(a => scoreAgainst(extracted, a)));
    if (!best || score > best.score) {
      runnerUp = best;
      best = { customer: c, score };
    } else if (!runnerUp || score > runnerUp.score) {
      runnerUp = { customer: c, score };
    }
  }

  if (!best || best.score < 0.35) return { status: 'new', extracted: extracted.trim() };

  // Two different customers the matcher cannot separate. Picking one
  // would come down to the order the roster happens to arrive in, and
  // the caller treats 'auto' as licence to overwrite the broker text —
  // so a silent tie-break doesn't just guess, it ERASES what the
  // dispatcher typed and re-guesses the same way on the next open.
  // That is how load 4920802 bounced back from "Trident Logistics" to
  // "Trident" four separate times. Ask instead; the banner already
  // knows how to offer both.
  const ambiguous =
    runnerUp != null &&
    runnerUp.customer.id !== best.customer.id &&
    best.score - runnerUp.score <= AMBIGUITY_MARGIN;

  if (ambiguous && runnerUp) {
    return { status: 'confirm', customer: best.customer, score: best.score, alternative: runnerUp.customer };
  }

  if (best.score >= 0.85) return { status: 'auto',    customer: best.customer, score: best.score };
  if (best.score >= 0.5)  return { status: 'confirm', customer: best.customer, score: best.score };
  return { status: 'new', extracted: extracted.trim() };
}
