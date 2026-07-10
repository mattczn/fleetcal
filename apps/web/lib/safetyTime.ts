/**
 * Time formatting for the safety-alert surfaces.
 *
 * Everything the panel + bell + drawer + notification-history block
 * renders goes through here so timestamps always land in the org's
 * dispatch timezone (America/Denver for Curzon — same TZ the API's
 * push-composer uses). Browser-local formatting is a footgun on a
 * cross-timezone team: a dispatcher on the East Coast covering a UT
 * driver would otherwise see "3 AM" when the truck actually did
 * something at 1 AM Mountain.
 *
 * DENVER_TZ is hardcoded for now — same as the API-side push copy in
 * apps/api/src/routes/performance-events.ts. Move to a per-org lookup
 * (org_settings.dispatch_timezone) if we ever roll safety alerts out to
 * a non-Mountain fleet.
 */

export const DENVER_TZ = 'America/Denver';

/** "Jul 10, 3:17 AM MDT" — used for the main event timestamp on the
 *  panel/drawer detail header. */
export function fmtDenverLong(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone:     DENVER_TZ,
    month:        'short',
    day:          'numeric',
    hour:         'numeric',
    minute:       '2-digit',
    timeZoneName: 'short',
  });
}

/** "7/10/2026, 12:04 AM MDT" — for audit-style rows (Notification sent). */
export function fmtDenverFull(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone:     DENVER_TZ,
    year:         'numeric',
    month:        'numeric',
    day:          'numeric',
    hour:         'numeric',
    minute:       '2-digit',
    timeZoneName: 'short',
  });
}

/** "3m ago" / "5h ago" / "Jul 8" — for the popover + panel list rows.
 *  Absolute fallback is date-only in Denver so the row doesn't jump to
 *  the browser locale for old events. */
export function relTimeDenver(iso: string): string {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return iso;
  const diffSec = (Date.now() - t) / 1000;
  if (diffSec < 60)    return 'just now';
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: DENVER_TZ,
    month:    'short',
    day:      'numeric',
  });
}
