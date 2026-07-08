/**
 * Ramp sk_category_name → FleetCal expense_category mapping.
 *
 * Applied on sync (for new rows) and on demand via the backfill
 * endpoint. Manual overrides are preserved separately (asset_link_source
 * = 'manual' OR match_status = 'manual_matched' short-circuits the
 * mapper on re-sync).
 *
 * Coverage of common Ramp categories today — extend as new ones surface
 * in production. Anything not on this list stays NULL and shows up on
 * the "Uncategorized" tile so a human can decide.
 */

import type { RampExpenseCategory } from "@fleetcal/types";

const RULES: Array<{ match: RegExp; category: RampExpenseCategory }> = [
  // Maintenance — parts, repair labor, tires, oil, DEF
  { match: /^(automotive|auto\s+parts|auto\s+repair|auto\s+service|tires?|oil\s+change|vehicle\s+repair|truck\s+repair)/i,
    category: "maintenance" },
  { match: /(parts|service).*(auto|truck|vehicle)/i,        category: "maintenance" },

  // Load expenses — lumpers, tolls, permits, truck stops, DOT scale fees
  { match: /^(freight|tolls?|lumpers?|permits?|scale|weigh\s+station|truck\s+stops?)/i,
    category: "load_expenses" },

  // Hotels / lodging — on-the-road stays
  { match: /^(lodging|hotels?|motels?|inns?)/i,             category: "hotels" },

  // Fuel (non-Mudflap card fuel-ups, cash fuel)
  { match: /^(fuel|gas(oline)?|petroleum|diesel)/i,         category: "fuel" },
  { match: /fuel\s*&\s*gas/i,                                category: "fuel" },

  // Overhead — software subs, office supplies, professional services
  { match: /^(software|subscriptions?|office\s+supplies|hardware\s+&?\s*software)/i,
    category: "office" },
  { match: /^(professional\s+services|legal|accounting|banking|insurance\s+(payment|premium))/i,
    category: "office" },
];

/** Returns the mapped category, or null when no rule fires. */
export function mapRampCategory(
  skCategoryName: string | null | undefined,
): RampExpenseCategory | null {
  if (!skCategoryName) return null;
  for (const { match, category } of RULES) {
    if (match.test(skCategoryName)) return category;
  }
  return null;
}
