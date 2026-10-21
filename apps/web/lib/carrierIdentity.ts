/**
 * Strip the CARRIER'S OWN details out of a parsed rate con.
 *
 * A rate con is addressed to the carrier, so the carrier's name,
 * address and MC/DOT numbers are printed on it — and the extractor
 * keeps mistaking them for load data:
 *
 *   • TQL prints the carrier block near the top:
 *       MC#/DOT#            Name                      Phone
 *       1213030 / 3586121   Curzon Trucking Llc (ut)  435-932-0578
 *       Address
 *       5428 RUSHMORE PARK LANE HERRIMAN, UT 84096
 *     and when the real pickup shows only "Commerce City, CO" (TQL
 *     withholds facility addresses until dispatch) that Herriman
 *     address got used as the pickup. A driver routed to his own yard.
 *
 *   • The same block's MC and DOT numbers come back as reference
 *     numbers, on every broker's paperwork, not just TQL's.
 *
 * The prompt tells the model not to do either. It still does, which is
 * why this exists: identity is something we KNOW, so it shouldn't rest
 * on the model choosing correctly. Nothing here is hardcoded to one
 * company — it all comes from the org's own invoice settings, which
 * every org fills in to render invoices.
 */

/** The org's own identity, read from org_settings.invoice_settings. */
export interface CarrierIdentity {
  companyName?: string | null;
  addressLine1?: string | null;
  city?:  string | null;
  state?: string | null;
  zip?:   string | null;
  mcNumber?:  string | null;
  dotNumber?: string | null;
}

export interface RefNum { label?: string; value?: string }

export interface StripResult {
  /** What changed, for logs and parseMeta. Empty when nothing matched. */
  removed: string[];
}

const norm = (s: unknown): string =>
  typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';

/** Digits only, so "MC# 1213030" and "1213030" compare equal. */
const digits = (s: unknown): string =>
  typeof s === 'string' || typeof s === 'number' ? String(s).replace(/\D+/g, '') : '';

/** Labels that are carrier identifiers by definition, whatever value
 *  they carry. Deliberately narrow — "ref" or "order" can legitimately
 *  be a load's own number, so only unambiguous ones are listed. */
const CARRIER_ID_LABEL = /\b(mc|dot|usdot|scac|ff|mc\s*#|dot\s*#|carrier\s*id|caller\s*id)\b/i;

/**
 * Drop reference numbers that are really the carrier's own identifiers.
 *
 * Two independent tests, because either alone misses cases: a ref
 * labelled "MC#" is one whatever its digits, and a ref carrying the
 * org's MC digits is one whatever it's labelled (TQL prints them as a
 * combined "1213030 / 3586121" field, which the model has labelled
 * everything from "MC/DOT" to "Reference").
 */
export function stripCarrierRefNums(
  refNums: unknown,
  identity: CarrierIdentity,
): { refNums: RefNum[]; removed: string[] } {
  if (!Array.isArray(refNums)) return { refNums: [], removed: [] };
  const ownNumbers = new Set(
    [identity.mcNumber, identity.dotNumber].map(digits).filter(d => d.length >= 5),
  );
  const kept: RefNum[] = [];
  const removed: string[] = [];
  for (const r of refNums as RefNum[]) {
    if (!r || typeof r !== 'object') continue;
    const label = String(r.label ?? '');
    const value = String(r.value ?? '');
    if (CARRIER_ID_LABEL.test(label)) {
      removed.push(`refNum "${label}: ${value}" (carrier identifier label)`);
      continue;
    }
    // The value may be the combined "1213030 / 3586121" — check each
    // run of digits in it, not just the whole string.
    const runs = value.match(/\d{5,}/g) ?? [];
    if (runs.length > 0 && runs.every(d => ownNumbers.has(d))) {
      removed.push(`refNum "${label}: ${value}" (our own MC/DOT)`);
      continue;
    }
    kept.push(r);
  }
  return { refNums: kept, removed };
}

/** Street-type suffixes, dropped before comparing. "5428 Rushmore Park
 *  Lane" and "5428 Rushmore Park Ln" are the same place, and whether
 *  it's spelled out depends on who typed it — the rate con, a geocoder,
 *  or the settings form. */
const STREET_SUFFIX = new Set([
  'lane', 'ln', 'street', 'st', 'avenue', 'ave', 'road', 'rd', 'drive', 'dr',
  'boulevard', 'blvd', 'court', 'ct', 'circle', 'cir', 'place', 'pl', 'way',
  'parkway', 'pkwy', 'highway', 'hwy', 'terrace', 'ter', 'trail', 'trl',
  'north', 'south', 'east', 'west', 'n', 's', 'e', 'w', 'suite', 'ste', 'unit',
]);

/**
 * True when an address string is the carrier's own.
 *
 * Compares the house number plus the distinctive street words, rather
 * than the raw string: suffixes and punctuation vary between the rate
 * con, the geocoder and the settings form, and a literal substring test
 * missed "5428 Rushmore Park Ln" against a stored "…Park Lane".
 *
 * Only the street is matched, never city or state on their own — Curzon
 * runs real loads out of Salt Lake City, and throwing away every stop in
 * the org's home town would be far worse than the bug being fixed.
 * Requiring the house number keeps "123 Rushmore Ave" in another state
 * from matching.
 */
export function isOwnAddress(address: unknown, identity: CarrierIdentity): boolean {
  const own = norm(identity.addressLine1).split(' ').filter(Boolean);
  if (own.length === 0) return false;
  const houseNo = own.find(w => /^\d+$/.test(w));
  const words = own.filter(w => !/^\d+$/.test(w) && !STREET_SUFFIX.has(w));
  if (!houseNo || words.length === 0) return false;
  const hay = norm(address).split(' ').filter(Boolean);
  if (!hay.includes(houseNo)) return false;
  if (!words.every(w => hay.includes(w))) return false;
  // A single generic street word is not enough on its own: an org at
  // "100 Main St" would otherwise match every "100 Main St" in the
  // country, and this clears a real address off a real stop — a driver
  // losing their destination is worse than the stray address this
  // exists to remove. Make the city agree too. Distinctive streets
  // (two or more words, like "Rushmore Park") stand on their own.
  if (words.length === 1) {
    const city = norm(identity.city);
    if (!city) return false;
    return city.split(' ').every(w => hay.includes(w));
  }
  return true;
}

/**
 * Blank any stop address that is really the carrier's own yard.
 *
 * Only the address is cleared, never the stop: the stop itself is real,
 * it's the location that got borrowed from the wrong block. City and
 * state are left alone — they come from the stop's own row and are
 * usually right even when the address isn't, and on a placeholder
 * city-only rate con the city is the ONLY location there is.
 */
export function stripOwnAddressFromStops(
  stops: unknown,
  identity: CarrierIdentity,
): { stops: unknown[]; removed: string[] } {
  if (!Array.isArray(stops)) return { stops: [], removed: [] };
  const removed: string[] = [];
  const out = (stops as Array<Record<string, unknown>>).map((s, i) => {
    if (!s || typeof s !== 'object') return s;
    if (!isOwnAddress(s.address, identity)) return s;
    removed.push(`stops[${i}].address "${String(s.address)}" (our own address)`);
    return { ...s, address: '' };
  });
  return { stops: out, removed };
}
