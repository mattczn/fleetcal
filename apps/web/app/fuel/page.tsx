/**
 * /fuel — legacy route, now redirects to /equipment?tab=fuel.
 *
 * The old fuel-reports page has been subsumed by the unified
 * Equipment tab. Kept as a redirect so any stale bookmarks /
 * external links land on the right place instead of 404'ing. If
 * we want the deeper fuel-reconciliation workflow back, fold it
 * into a sub-view of Equipment's Fuel tab.
 */
import { redirect } from 'next/navigation';

export default function FuelLegacyRedirect() {
  redirect('/equipment?tab=fuel');
}
