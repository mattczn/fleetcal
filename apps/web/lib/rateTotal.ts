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

  // They disagree. Only trust the total if the components the model
  // reported actually add up to it — that's the signature of having
  // read a real table rather than guessed at one. When it reported no
  // components at all, a printed total is still the better source than
  // a figure that contradicts it.
  const parts = [breakdown?.lineHaul, breakdown?.fuelSurcharge, breakdown?.otherAgreed]
    .map(num)
    .filter((n): n is number => n != null);
  if (parts.length > 0) {
    const sum = parts.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - total) > CENTS_SLACK) {
      // The model's own numbers are inconsistent — it may have misread
      // the table entirely. Leave the extracted price alone rather than
      // trade one wrong number for another.
      return {
        loadPrice: price,
        corrected: false,
        note: `rate breakdown inconsistent (parts sum ${sum.toFixed(2)} vs printed total ${total.toFixed(2)}); kept extracted ${price}`,
      };
    }
  }

  return {
    loadPrice: total,
    corrected: true,
    note: `extracted ${price} but rate con totals ${total.toFixed(2)}` +
      (breakdown?.fuelSurcharge ? ` (incl. fuel surcharge ${Number(breakdown.fuelSurcharge).toFixed(2)})` : '') +
      '; used the total',
  };
}
