/**
 * Formats a thrown error from a hard-delete attempt into a readable
 * sentence for an alert(). Pulls structured 'blockers' off the API's
 * 409 response when present and lists the table breakdown.
 */
import { RailwayError } from '@/lib/railway';

const LABELS: Record<string, string> = {
  loads:                       'load',
  events:                      'load',
  fuel_reports:                'fuel report',
  maintenance_reports:         'maintenance report',
  maintenance_action_items:    'maintenance action item',
  inspection_reports:          'inspection report',
  push_tokens:                 'push token',
  notification_prefs:          'notification preference',
  load_notifications:          'load notification',
  documents:                   'document',
  evening_sweeps:              'evening sweep',
};

function pluralize(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

export function formatHardDeleteError(entity: 'asset' | 'driver' | 'trailer', err: unknown): string {
  if (err instanceof RailwayError && err.status === 409) {
    const detail = err.detail as { blockers?: Record<string, number>; detail?: string } | null;
    const blockers = detail?.blockers ?? {};
    const parts = Object.entries(blockers)
      .filter(([, n]) => n > 0)
      .map(([key, n]) => pluralize(n, LABELS[key] ?? key.replace(/_/g, ' ')));
    if (parts.length > 0) {
      return `Can't permanently delete this ${entity} — still referenced by ${parts.join(', ')}. Retire instead to keep the history.`;
    }
    return detail?.detail ?? `Can't permanently delete this ${entity}.`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Couldn't delete ${entity}: ${msg}`;
}
