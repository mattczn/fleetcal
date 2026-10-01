/**
 * Recover a missing load number from the reference numbers the same
 * parse already found.
 *
 * Brokers do not agree on what to call their own load number. Freight
 * Tec prints it as "PRO #", others print "Order #", "Load
 * Confirmation", "Our Reference". The extractor's Load # hint asked
 * for a "load or order number" while the reference-numbers hint
 * explicitly listed PRO # and order ID as things to collect — so on
 * those rate cons the primary identifier got filed as a reference and
 * Load # came back empty for a dispatcher to type in off the PDF. The
 * hints now draw the line differently; this is the guard for the cases
 * where the model still leaves Load # blank.
 *
 * WHICH LABELS ARE SAFE TO PROMOTE is measured, not guessed. Of 1,634
 * Curzon-entered loads carrying reference numbers, the load number the
 * dispatcher settled on appears among the references on 708 — and
 * those give a precision figure per label (hit = that label held the
 * load number; miss = it was present but the load number was a
 * different ref). lib/loadNumber.labels.ts regenerates this:
 *
 *     our reference     21 hit /  0 miss  100%
 *     load confirmation 15 hit /  0 miss  100%
 *     pro              406 hit / 29 miss   93%
 *     order             46 hit /  4 miss   92%
 *     load / load id     10 hit /  2 miss   83%
 *     ─────────────────────────────────────────
 *     confirmation       8 hit /  6 miss   57%
 *     po                75 hit / 76 miss   50%
 *     bol               21 hit / 54 miss   28%
 *     cust ref          16 hit /208 miss    7%
 *     pickup / ref / delivery / EDI codes    0%
 *
 * Only the top group is promotable. A BOL or a PO identifies freight,
 * not the load: promoting one would write a number the broker does not
 * recognise into the field that drives invoicing and duplicate
 * detection, and a wrong load number is worse than an empty one —
 * empty is visibly missing, wrong is silent. When only low-precision
 * labels are present the field stays empty on purpose.
 *
 * Matching is on the label's FIRST word, which is what separates
 * "Order #" (92%) from "Purchase Order" and "Sales Order" (0%), and
 * "Load Confirmation" (100%) from "External Load Reference" (0%).
 *
 * Replayed over those loads (lib/loadNumber.backtest.ts), the rule
 * picks the dispatcher's own number on 503 of the 561 loads where it
 * fires — 90% — and stays out of the way on 97.5% of the loads whose
 * load number was never in the references at all. Most of the
 * remaining disagreements are Freight Tec loads from earlier in the
 * year, where Curzon used to file the customer reference as the load
 * number and now uses the PRO.
 *
 * The number is PROMOTED, not moved — the reference chip stays where
 * it is. On the loads Curzon dispatchers fixed by hand the value sits
 * in both places (57 of 60 recent Freight Tec loads), so keeping both
 * matches the data already in the table.
 *
 * Only ever fills an EMPTY load number. A value the model returned is
 * left alone: it read the document and this function did not.
 */

export interface RefNumLike {
  label?: string;
  value?: string;
}

export interface LoadNumberResult {
  /** The load number to use. Unchanged unless `promoted` is true. */
  loadNum: string;
  /** True when a reference number was lifted into the load number. */
  promoted: boolean;
  /** The label it came from, for logs and parseMeta. */
  fromLabel?: string;
  /** Human-readable reason, for logs and parseMeta. */
  note?: string;
}

/**
 * Promotable label families, best first. Each entry matches the
 * label's first word, except the phrase entries which match a prefix.
 * Ranking inside this list barely matters (93% vs 92% vs 89%) — it
 * only breaks the tie when a rate con carries two of them.
 */
const PROMOTABLE: Array<{ firstWord?: string; prefix?: string }> = [
  { firstWord: 'load' },      // load, load confirmation, load id, load ref
  { prefix: 'our ref' },      // our reference — the broker's own handle
  { firstWord: 'pro' },       // pro, pro number  (Freight Tec's load number)
  { firstWord: 'order' },     // order, order id, order no
];
// Deliberately NOT here: "Shipment ID" and "Trip #". Both read like
// primary identifiers and both fail the backtest — Shipment ID alone
// accounts for 58 wrong promotions against 16 right ones, because the
// brokers who print it (Arrive, and others routing through a TMS) also
// print a separate load number that the extractor normally finds.
// Leaving them out costs 16 recoveries and buys back 58 wrong numbers.

/**
 * Labels that are never a load number, whatever else they contain.
 * "MC #" and "DOT #" identify the carrier, "SCAC" its code, and an
 * invoice number is ours rather than the broker's. Checked first so a
 * label like "Driver Reference Pro" can't slip a carrier identifier
 * into the load number.
 */
const NEVER = ['mc', 'dot', 'scac', 'ein', 'invoice', 'trailer', 'truck', 'tractor', 'driver', 'phone', 'fax', 'zip', 'quote', 'seal'];

const normalise = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Rank of this label among the promotable families, or -1 when the
 * label is not one we trust. An unlabelled reference is never
 * promoted: with no label there is no evidence, and the one real case
 * in the data (an unlabelled 11828654 on a load numbered 101824) was
 * the wrong number.
 */
function rankOf(rawLabel: string): number {
  const label = normalise(rawLabel);
  if (!label) return -1;
  const words = label.split(' ');
  if (NEVER.some(bad => words.includes(bad))) return -1;
  for (let i = 0; i < PROMOTABLE.length; i++) {
    const { firstWord, prefix } = PROMOTABLE[i];
    if (firstWord && words[0] === firstWord) return i;
    if (prefix && label.startsWith(prefix)) return i;
  }
  return -1;
}

/**
 * Does this value look like something a dispatcher would quote as a
 * load number? Load numbers are short identifiers carrying digits.
 * This rejects what ends up in a reference list wearing a plausible
 * label: a date, a temperature, a dollar figure, a phone number, a
 * sentence.
 */
function plausibleValue(raw: string): boolean {
  const v = raw.trim();
  if (v.length < 4 || v.length > 32) return false;
  if (!/\d/.test(v)) return false;                                  // must carry digits
  if (/^[\d.,]+$/.test(v) && v.includes('.')) return false;         // 3,900.00 → money
  if (/^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$/.test(v)) return false;   // 06/04/2026
  if (/^[-+]?\d+\s*°?\s*[fc]$/i.test(v)) return false;              // -10F
  if (/^\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}$/.test(v)) return false;  // phone
  if (v.split(/\s+/).length > 3) return false;                      // a sentence
  return true;
}

function toRefs(raw: unknown): RefNumLike[] {
  if (Array.isArray(raw)) return raw as RefNumLike[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as RefNumLike[];
    } catch { /* not JSON — a bare comma list carries no labels, so
                 nothing in it can be ranked. */ }
  }
  return [];
}

/**
 * `loadNum` and `refNums` are whatever the extractor returned —
 * refNums may arrive as an array or as a JSON string.
 */
export function promoteLoadNumber(loadNum: unknown, refNums: unknown): LoadNumberResult {
  const existing = typeof loadNum === 'string' ? loadNum.trim() : '';
  if (existing) return { loadNum: existing, promoted: false };

  const refs = toRefs(refNums);
  if (refs.length === 0) return { loadNum: '', promoted: false };

  let bestRank = Number.POSITIVE_INFINITY;
  let label = '';
  let value = '';

  for (const ref of refs) {
    const v = typeof ref?.value === 'string' ? ref.value.trim() : '';
    const l = typeof ref?.label === 'string' ? ref.label.trim() : '';
    if (!v || !plausibleValue(v)) continue;
    const rank = rankOf(l);
    if (rank < 0) continue;
    // Strictly better only, so ties go to document order: the number a
    // broker prints first is the one it leads with.
    if (rank < bestRank) { bestRank = rank; label = l; value = v; }
  }

  if (!value) return { loadNum: '', promoted: false };

  return {
    loadNum:   value,
    promoted:  true,
    fromLabel: label,
    note: `load number was empty; promoted "${label}" ${value} from the reference numbers`,
  };
}
