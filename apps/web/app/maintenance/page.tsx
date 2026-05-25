/**
 * /maintenance — legacy route, now redirects to /equipment?tab=maintenance.
 *
 * The old maintenance-reports + action-items page has been subsumed
 * by the unified Equipment tab. Kept as a redirect so any stale
 * bookmarks / external links land on the right place instead of
 * 404'ing. The action-items workflow that used to live here can be
 * folded back into Equipment as a sub-view if/when ops needs it.
 */
import { redirect } from 'next/navigation';

export default function MaintenanceLegacyRedirect() {
  redirect('/equipment?tab=maintenance');
}
