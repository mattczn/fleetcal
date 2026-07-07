/**
 * Ramp memo → asset matcher. Freeform prose in, (asset_id | trailer_id,
 * source, confidence, status) out.
 *
 * Priority order (first hit wins). Cutoff for auto_matched is conf ≥ 40:
 *   95  memo_unit    unit token in memo   (assets.unit / trailers.unit)
 *   90  memo_vin     17-char VIN substring
 *   80  memo_plate   normalized plate substring (≥5 chars)
 *   60  driver_name  first/last name (≥3 chars) → driver_asset_prefs
 *   40  nickname     assets.name substring (≥4 chars)
 *
 * Categories in NON_EQUIPMENT_CATEGORIES that DIDN'T match anything are
 * marked not_applicable so the "Needs review" filter stays useful (won't
 * surface Adobe Creative Cloud charges alongside missing truck memos).
 * A memo that mentions a truck STILL matches even in a non-equipment
 * category — the human wrote it deliberately.
 */

import { supabase } from "./supabase.js";

export type RampMatchSource =
  | "memo_unit" | "memo_vin" | "memo_plate"
  | "driver_name" | "nickname" | "none";

export type RampMatchStatus =
  | "unmatched" | "auto_matched" | "not_applicable";

export interface RampMatchResult {
  asset_id:   number | null;
  trailer_id: number | null;
  source:     RampMatchSource;
  confidence: number | null;
  status:     RampMatchStatus;
  notes:      string | null;
}

interface AssetForMatch {
  id: number;
  unit: string | null;
  vin: string | null;
  license_plate: string | null;
  name: string | null;
}
interface TrailerForMatch {
  id: number;
  unit: string | null;         // aliased from trailers.trailer_number for a shared matcher shape
  vin: string | null;
  license_plate: string | null;
}
interface DriverPref {
  asset_id: number;
  first_name: string | null;
  last_name: string | null;
}

export interface RampMatchInputs {
  assets: AssetForMatch[];
  trailers: TrailerForMatch[];
  driverPrefs: DriverPref[];
}

const NON_EQUIPMENT_CATEGORIES = new Set([
  "Advertising", "Software", "Subscriptions", "Office Supplies",
  "Meals", "Travel", "Lodging", "Utilities", "Insurance",
  "Legal", "Professional Services", "Banking", "Entertainment",
]);

const normalize = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function loadRampMatchInputs(orgId: string): Promise<RampMatchInputs> {
  const [assetsRes, trailersRes, prefsRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("assets")
      .select("id, unit, vin, license_plate, name")
      .eq("org_id", orgId),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("trailers")
      .select("id, trailer_number, vin, license_plate")
      .eq("org_id", orgId),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("driver_asset_prefs")
      .select("asset_id, driver_id")
      .eq("org_id", orgId),
  ]);
  if (assetsRes.error)  throw new Error(`assets fetch: ${assetsRes.error.message}`);
  if (trailersRes.error) throw new Error(`trailers fetch: ${trailersRes.error.message}`);
  if (prefsRes.error)   throw new Error(`driver_asset_prefs fetch: ${prefsRes.error.message}`);

  const prefRows = (prefsRes.data ?? []) as Array<{ asset_id: number; driver_id: number | null }>;
  const driverIds = [...new Set(prefRows.map(p => p.driver_id).filter((n): n is number => n != null))];
  let driverById = new Map<number, { first_name: string | null; last_name: string | null }>();
  if (driverIds.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: drivers, error: dErr } = await (supabase as any)
      .from("drivers")
      .select("id, first_name, last_name")
      .in("id", driverIds);
    if (dErr) throw new Error(`drivers fetch: ${dErr.message}`);
    driverById = new Map(
      (drivers ?? []).map((d: { id: number; first_name: string | null; last_name: string | null }) =>
        [d.id, { first_name: d.first_name, last_name: d.last_name }] as const),
    );
  }
  const driverPrefs: DriverPref[] = prefRows
    .filter(p => p.driver_id != null)
    .map(p => ({
      asset_id: p.asset_id,
      first_name: driverById.get(p.driver_id!)?.first_name ?? null,
      last_name:  driverById.get(p.driver_id!)?.last_name  ?? null,
    }));

  const trailerRows = (trailersRes.data ?? []) as Array<{
    id: number; trailer_number: string | null;
    vin: string | null; license_plate: string | null;
  }>;
  return {
    assets: (assetsRes.data ?? []) as AssetForMatch[],
    trailers: trailerRows.map(t => ({
      id: t.id,
      unit: t.trailer_number,
      vin: t.vin,
      license_plate: t.license_plate,
    })),
    driverPrefs,
  };
}

function findUnitMatch<T extends { id: number; unit: string | null }>(
  list: T[], memoTokens: string[], memoNorm: string,
): T | null {
  for (const item of list) {
    const unit = item.unit?.trim();
    if (!unit || unit.length < 2) continue;
    const unitLc = unit.toLowerCase();
    if (memoTokens.includes(unitLc)) return item;
    // Alphanumeric compound units ("CT-2021", "T45"): match normalized
    // substring so "CT2021 oil change" hits "CT-2021".
    if (/[a-z]/i.test(unit) && /\d/.test(unit)) {
      const unitNorm = normalize(unit);
      if (unitNorm.length >= 4 && memoNorm.includes(unitNorm)) return item;
    }
  }
  return null;
}

export function matchMemo(
  memo: string | null | undefined,
  category: string | null | undefined,
  inputs: RampMatchInputs,
): RampMatchResult {
  const empty: RampMatchResult = {
    asset_id: null, trailer_id: null, source: "none",
    confidence: null, notes: null, status: "unmatched",
  };
  const notApplicable: RampMatchResult = {
    ...empty,
    status: "not_applicable",
    notes: "Category not tied to equipment",
  };

  const memoRaw = (memo ?? "").trim();
  if (!memoRaw) {
    return category && NON_EQUIPMENT_CATEGORIES.has(category) ? notApplicable : empty;
  }
  const memoLc = memoRaw.toLowerCase();
  const memoTokens = memoLc.split(/[^a-z0-9]+/i).filter(Boolean);
  const memoNorm = normalize(memoRaw);

  // 1. Unit — check trucks first, then trailers.
  const assetUnit = findUnitMatch(inputs.assets, memoTokens, memoNorm);
  if (assetUnit) {
    return { asset_id: assetUnit.id, trailer_id: null, source: "memo_unit",
             confidence: 95, notes: `unit "${assetUnit.unit}" in memo`,
             status: "auto_matched" };
  }
  const trailerUnit = findUnitMatch(inputs.trailers, memoTokens, memoNorm);
  if (trailerUnit) {
    return { asset_id: null, trailer_id: trailerUnit.id, source: "memo_unit",
             confidence: 95, notes: `trailer unit "${trailerUnit.unit}" in memo`,
             status: "auto_matched" };
  }

  // 2. VIN
  for (const a of inputs.assets) {
    if (a.vin && a.vin.length === 17 && memoLc.includes(a.vin.toLowerCase())) {
      return { asset_id: a.id, trailer_id: null, source: "memo_vin",
               confidence: 90, notes: "VIN in memo", status: "auto_matched" };
    }
  }
  for (const t of inputs.trailers) {
    if (t.vin && t.vin.length === 17 && memoLc.includes(t.vin.toLowerCase())) {
      return { asset_id: null, trailer_id: t.id, source: "memo_vin",
               confidence: 90, notes: "trailer VIN in memo", status: "auto_matched" };
    }
  }

  // 3. License plate (normalized substring)
  for (const a of inputs.assets) {
    if (a.license_plate) {
      const plate = normalize(a.license_plate);
      if (plate.length >= 5 && memoNorm.includes(plate)) {
        return { asset_id: a.id, trailer_id: null, source: "memo_plate",
                 confidence: 80, notes: "plate in memo", status: "auto_matched" };
      }
    }
  }
  for (const t of inputs.trailers) {
    if (t.license_plate) {
      const plate = normalize(t.license_plate);
      if (plate.length >= 5 && memoNorm.includes(plate)) {
        return { asset_id: null, trailer_id: t.id, source: "memo_plate",
                 confidence: 80, notes: "trailer plate in memo", status: "auto_matched" };
      }
    }
  }

  // 4. Driver name → driver_asset_prefs
  for (const pref of inputs.driverPrefs) {
    for (const name of [pref.first_name, pref.last_name]) {
      if (!name || name.trim().length < 3) continue;
      if (memoTokens.includes(name.toLowerCase())) {
        return { asset_id: pref.asset_id, trailer_id: null, source: "driver_name",
                 confidence: 60, notes: `driver "${name}" → assigned asset`,
                 status: "auto_matched" };
      }
    }
  }

  // 5. Nickname (asset.name)
  for (const a of inputs.assets) {
    if (a.name && a.name.trim().length >= 4) {
      const nameLc = a.name.toLowerCase();
      if (memoLc.includes(nameLc)) {
        return { asset_id: a.id, trailer_id: null, source: "nickname",
                 confidence: 40, notes: `name "${a.name}" in memo`,
                 status: "auto_matched" };
      }
    }
  }

  return category && NON_EQUIPMENT_CATEGORIES.has(category) ? notApplicable : empty;
}
