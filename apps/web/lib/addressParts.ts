/**
 * Pure address helpers — no network, no Node built-ins.
 *
 * Deliberately separate from lib/geocode.ts. That module pulls in
 * geo-tz, which requires `fs`, so importing anything from it inside a
 * route handler or a client component breaks the Turbopack build with
 * "Can't resolve 'fs'". These two functions are the parts callers
 * actually want to share, and they need neither.
 */

export interface GoogleAddressComponent {
  long_name:  string;
  short_name: string;
  types:      string[];
}

/**
 * Pull city + state out of Google's structured address_components in a
 * way that's stable across countries (US locality, UK postal_town, etc.).
 */
export function extractCityState(components: GoogleAddressComponent[] | undefined):
  { city?: string; state?: string }
{
  if (!components?.length) return {};
  const find = (...types: string[]) =>
    components.find((c) => types.some((t) => c.types.includes(t)));
  const cityComp =
    find("locality") ??
    find("postal_town") ??
    find("sublocality_level_1") ??
    find("sublocality") ??
    find("administrative_area_level_3");
  const stateComp = find("administrative_area_level_1");
  return {
    city:  cityComp?.long_name,
    state: stateComp?.short_name,
  };
}

/**
 * Best-effort city/state out of a formatted address STRING.
 *
 * For sources that store only a formatted address and no structured
 * components — saved locations are the case that matters: picking one
 * set the stop's address and pin but left its city naming the previous
 * town. Anchors on the "UT 84104" segment rather than counting commas,
 * so it works whether or not the string ends in ", USA".
 *
 * Returns {} when it can't find that anchor. Callers should treat a
 * blank result as "unknown", never as "clear what's there".
 */
export function parseCityStateFromAddress(address: string | null | undefined):
  { city?: string; state?: string }
{
  if (!address?.trim()) return {};
  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  const idx = parts.findIndex(p => /^[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
  if (idx < 1) return {};
  return {
    city:  parts[idx - 1] || undefined,
    state: parts[idx].slice(0, 2).toUpperCase(),
  };
}
