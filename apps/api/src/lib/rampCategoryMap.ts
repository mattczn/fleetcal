/**
 * Ramp sk_category_name → FleetCal bucket mapping.
 *
 * This file used to be the runtime auto-mapper. It's now DEFAULTS ONLY:
 * the ramp_category_rules table is the source of truth at sync time.
 * The DEFAULT_RAMP_RULES below are what the "Seed defaults" endpoint
 * inserts as DB rows for an org that hasn't customized their rules yet.
 *
 * Runtime matching happens against rules loaded from the DB via
 * matchRuleAgainst() below — same in-memory shape either way.
 */

import type { ExpenseBucketKey } from "@fleetcal/types";

export interface RampRule {
  pattern:   string;     // regex or literal
  isRegex:   boolean;
  bucketKey: ExpenseBucketKey;
  priority:  number;
}

/** Starter regex → bucket mappings. Seeded into ramp_category_rules
 *  on demand via POST /v1/ramp-category-rules/seed-defaults. Once
 *  seeded, the DB is authoritative; editing DEFAULT_RAMP_RULES has no
 *  runtime effect until reseeded. */
export const DEFAULT_RAMP_RULES: RampRule[] = [
  // Fleet Ops — vehicle maintenance, tolls, fuel, hotels-on-the-road
  { pattern: "^(automotive|auto\\s+parts|auto\\s+repair|auto\\s+service|tires?|oil\\s+change|vehicle\\s+repair|truck\\s+repair)",
    isRegex: true, bucketKey: "fleet_ops", priority: 100 },
  { pattern: "(parts|service).*(auto|truck|vehicle)",
    isRegex: true, bucketKey: "fleet_ops", priority: 100 },
  { pattern: "^(freight|tolls?|lumpers?|permits?|scale|weigh\\s+station|truck\\s+stops?)",
    isRegex: true, bucketKey: "fleet_ops", priority: 100 },
  { pattern: "^(lodging|hotels?|motels?|inns?)",
    isRegex: true, bucketKey: "fleet_ops", priority: 100 },
  { pattern: "^(fuel|gas(oline)?|petroleum|diesel)",
    isRegex: true, bucketKey: "fleet_ops", priority: 100 },
  { pattern: "fuel\\s*&\\s*gas",
    isRegex: true, bucketKey: "fleet_ops", priority: 100 },

  // Software & Overhead — SaaS, office supplies, banking, professional services
  { pattern: "^(software|subscriptions?|office\\s+supplies|hardware\\s+&?\\s*software)",
    isRegex: true, bucketKey: "software_overhead", priority: 100 },
  { pattern: "^(professional\\s+services|legal|accounting|banking)",
    isRegex: true, bucketKey: "software_overhead", priority: 100 },

  // Insurance & Claims
  { pattern: "^(insurance\\s+(payment|premium|policy))",
    isRegex: true, bucketKey: "insurance_claims", priority: 100 },
];

export type MatchedAssetKind = "truck" | "trailer" | null;

/** Match a single Ramp sk_category_name against a set of rules. Returns
 *  the first matching rule's bucket_id by ascending priority, or null.
 *
 *  `assetKind` is what the memo matcher resolved on the txn — rules
 *  with an asset_scope other than 'any' only fire when it agrees, so
 *  the same category pattern can route to different sub-buckets based
 *  on whether the memo named a truck, a trailer, or nothing. */
export function matchRuleAgainst(
  skCategoryName: string | null | undefined,
  rules: Array<{ pattern: string; is_regex: boolean; bucket_id: string; priority: number; asset_scope?: string }>,
  assetKind: MatchedAssetKind = null,
): string | null {
  if (!skCategoryName) return null;
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const r of sorted) {
    const scope = r.asset_scope ?? "any";
    if (scope === "truck"   && assetKind !== "truck")   continue;
    if (scope === "trailer" && assetKind !== "trailer") continue;
    if (scope === "none"    && assetKind !== null)      continue;
    let matched = false;
    if (r.is_regex) {
      try {
        matched = new RegExp(r.pattern, "i").test(skCategoryName);
      } catch { matched = false; }
    } else {
      matched = skCategoryName.toLowerCase().includes(r.pattern.toLowerCase());
    }
    if (matched) return r.bucket_id;
  }
  return null;
}
