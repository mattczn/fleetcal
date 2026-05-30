/**
 * Old per-asset timeline path. Redirects to the unified /timeline
 * endpoint with the truck pre-selected via the assetId query param.
 *
 * Kept as a redirect for any bookmarks or external links pointing at
 * the old URL. New nav goes directly to /timeline?assetId=…
 */
import { redirect } from 'next/navigation';

export default function LegacyAssetTimelineRedirect({ params }: { params: { id: string } }) {
  redirect(`/timeline?assetId=${params.id}`);
}
