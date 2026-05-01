import type { Customer, CustomerMatchResult } from './types';

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

function scoreAgainst(extracted: string, candidate: string): number {
  const normEx = normalizeName(extracted);
  const normCand = normalizeName(candidate);

  // If normalization wiped out one or both names (all stop words), fall back to raw
  const rawEx   = extracted.toLowerCase().trim();
  const rawCand = candidate.toLowerCase().trim();

  if (!normEx || !normCand) {
    if (rawEx === rawCand) return 1.0;
    if (rawCand.includes(rawEx) || rawEx.includes(rawCand)) return 0.85;
    return 0;
  }

  // Exact normalized match
  if (normEx === normCand) return 1.0;

  // One fully contains the other
  if (normCand.includes(normEx) || normEx.includes(normCand)) return 0.9;

  // Jaccard on word sets
  return jaccard(wordSet(normEx), wordSet(normCand)) * 0.95;
}

export function matchCustomer(
  extracted: string,
  customers: Customer[],
): CustomerMatchResult {
  if (!extracted?.trim()) return { status: 'none' };
  if (customers.length === 0) return { status: 'new', extracted: extracted.trim() };

  let best: { customer: Customer; score: number } | null = null;

  for (const c of customers) {
    const candidates = [c.name, ...c.aliases];
    const score = Math.max(...candidates.map(a => scoreAgainst(extracted, a)));
    if (!best || score > best.score) best = { customer: c, score };
  }

  if (!best || best.score < 0.35) return { status: 'new', extracted: extracted.trim() };
  if (best.score >= 0.85)         return { status: 'auto',    customer: best.customer, score: best.score };
  if (best.score >= 0.5)          return { status: 'confirm', customer: best.customer, score: best.score };
  return { status: 'new', extracted: extracted.trim() };
}
