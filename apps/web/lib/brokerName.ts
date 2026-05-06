/**
 * "Direct Connect Logistics Inc" → "Direct Connect"
 * "River City Logistics, Inc."   → "River City"
 * "ABC Trucking Co"              → "ABC Trucking"     (Co stripped, Trucking kept)
 *
 * Strips trailing legal entity / industry suffixes that broker names
 * accumulate but nobody reads. Runs the regexes iteratively so a name
 * like "Direct Connect Logistics, Inc." sheds the suffixes one at a
 * time. Refuses to shrink the result below 3 characters so a name
 * like "Logistics LLC" doesn't disappear entirely.
 */

const SUFFIX_PATTERNS: RegExp[] = [
  // Legal entity types
  /[,]?\s+L\.?L\.?C\.?$/i,
  /[,]?\s+(?:Inc|Incorporated)\.?$/i,
  /[,]?\s+(?:Ltd|Limited)\.?$/i,
  /[,]?\s+(?:Corp|Corporation)\.?$/i,
  /[,]?\s+(?:Co|Company)\.?$/i,
  /[,]?\s+L\.?P\.?$/i,
  /[,]?\s+L\.?L\.?P\.?$/i,
  /[,]?\s+P\.?C\.?$/i,
  // Trucking-industry suffixes — trailing only, only when the name
  // has more than the suffix word left. The 3-char floor in the
  // function itself enforces that.
  /\s+Logistics?\.?$/i,
  /\s+Transport(?:ation)?\.?$/i,
  /\s+Trucking\.?$/i,
  /\s+Freight\.?$/i,
  /\s+Shipping\.?$/i,
  /\s+Carrier(s)?\.?$/i,
  /\s+Services?\.?$/i,
  /\s+Solutions?\.?$/i,
  /\s+(?:Group|Holdings?|Enterprises?|Industries)\.?$/i,
  // Trailing punctuation / whitespace
  /[,.\s]+$/,
];

export function cleanBrokerName(raw: string | null | undefined): string {
  if (!raw) return "";
  let result = raw.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of SUFFIX_PATTERNS) {
      const next = result.replace(pattern, "").trim();
      // Refuse to whittle the name down to nothing or near-nothing.
      if (next !== result && next.length >= 3) {
        result = next;
        changed = true;
      }
    }
  }
  return result;
}
