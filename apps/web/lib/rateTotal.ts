/**
 * Cross-check the extracted loadPrice against the rate table the model
 * says it read, and correct it when the two disagree.
 *
 * A rate con that itemises —
 *
 *     LineHaul          $3,099.15
 *     Fuel Surcharge      $800.85
 *     Total             $3,900.00
 *
 * — has a line literally labelled "LineHaul", and the extractor used to
 * return that figure because its field hint asked for the linehaul
 * "BEFORE accessorials". Nothing downstream recovers the surcharge: the
 * parser doesn't extract accessorials, so `total_billable` came out at
 * 3099.15 and the load was invoiced $800.85 short. The hint now asks for
 * the grand total; this is the guard that catches the cases where the
 * model still picks the wrong line.
 *
 * The correction only fires on evidence the model genuinely read an
 * itemised table — a printed total, with the components it reported
 * actually summing to it. A model that returns a total it half-invented
 * gets ignored rather than silently rewriting the price on a load.
 */

/** Rate lines the model reports having seen. Any line the document
 *  doesn't print comes back null. */
export interface RateBreakdown {
  lineHaul?:      number | null;
  fuelSurcharge?: number | null;
  otherAgreed?:   number | null;
  printedTotal?:  number | null;
}

export interface RateCheckResult {
  /** The price to use. Unchanged unless `corrected` is true. */
  loadPrice: number | null;
  /** True when the printed total replaced the extracted figure. */
  corrected: boolean;
  /** Human-readable reason, for logs and parseMeta. */
  note?: string;
}

/** Money comparison. Two cents of slack absorbs the rounding a broker's
 *  own PDF sometimes carries; anything wider is a real disagreement. */
const CENTS_SLACK = 0.02;

const num = (v: unknown): number | null =>
  typeof v === 'number' && isFinite(v) ? v : null;

/**
 * `loadPrice` is whatever the extractor returned; `breakdown` is its
 * scratchpad. Returns the price to persist.
 */
export function reconcileLoadPrice(
  loadPrice: unknown,
  breakdown: RateBreakdown | null | undefined,
): RateCheckResult {
  const price = num(loadPrice);
  const total = num(breakdown?.printedTotal);

  // No total line on the document. Not every rate con prints one, and
  // the components are still evidence: if the extracted price is the
  // linehaul and there are other agreed charges beside it, the model
  // took the wrong line and the sum is what the broker owes.
  if (total == null || total <= 0) {
    const lineHaul = num(breakdown?.lineHaul);
    const extras = [breakdown?.fuelSurcharge, breakdown?.otherAgreed]
      .map(num)
      .filter((n): n is number => n != null && n !== 0);
    if (price != null && lineHaul != null && extras.length > 0 && Math.abs(price - lineHaul) <= CENTS_SLACK) {
      const sum = lineHaul + extras.reduce((a, b) => a + b, 0);
      return {
        loadPrice: sum,
        corrected: true,
        note: `no total printed; extracted ${price} was the linehaul, summed agreed lines to ${sum.toFixed(2)}`,
      };
    }
    return { loadPrice: price, corrected: false };
  }
  if (price == null) {
    return { loadPrice: total, corrected: true, note: `no loadPrice extracted; used printed total ${total}` };
  }
  if (Math.abs(price - total) <= CENTS_SLACK) return { loadPrice: price, corrected: false };

  // They disagree, and the printed total is the most reliable figure on
  // the page — it's the number the broker pays against.
  //
  // This used to also demand that the components the model reported add
  // up to the total, and only correct if they did. That rejected a real
  // case: a rate con reading "Freight - flat $1,400 / Accessorial -
  // delivery appointment $300 / Total $1,700". A model that classifies
  // the $300 line as an accessorial reports lineHaul 1400 and nothing
  // else, so the parts summed to 1400 against a total of 1700 and the
  // guard "protected" the wrong number. A component the model left out
  // is not the same as a total it invented.
  //
  // What's left is a sanity band on the total itself. A real rate con's
  // total sits between the linehaul and a modest multiple of it —
  // surcharges and agreed fees add tens of percent, not multiples. A
  // figure outside that band is more likely a misread (a PRO number, a
  // weight, an insurance limit) than a rate, so the extracted value
  // stands and the disagreement is logged instead.
  const MAX_TOTAL_MULTIPLE = 3;
  if (total < price - CENTS_SLACK) {
    // Total BELOW the extracted price. Could be a subtotal misread as
    // the total, or the model over-read the rate. Either way, guessing
    // risks over-billing a broker, so leave it and surface the conflict.
    return {
      loadPrice: price,
      corrected: false,
      note: `printed total ${total.toFixed(2)} is BELOW extracted ${price}; left alone — check the rate con`,
    };
  }
  if (total > price * MAX_TOTAL_MULTIPLE) {
    return {
      loadPrice: price,
      corrected: false,
      note: `printed total ${total.toFixed(2)} is more than ${MAX_TOTAL_MULTIPLE}x extracted ${price}; looks misread, kept ${price}`,
    };
  }

  const extras = [
    breakdown?.fuelSurcharge != null ? `fuel ${Number(breakdown.fuelSurcharge).toFixed(2)}` : null,
    breakdown?.otherAgreed   != null ? `other agreed ${Number(breakdown.otherAgreed).toFixed(2)}`   : null,
  ].filter(Boolean).join(', ');
  return {
    loadPrice: total,
    corrected: true,
    note: `extracted ${price} but rate con totals ${total.toFixed(2)}` +
      (extras ? ` (${extras})` : '') +
      '; used the total',
  };
}
