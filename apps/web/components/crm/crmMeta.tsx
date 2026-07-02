'use client';

/**
 * Shared CRM UI metadata — status chip palette + labels, the "local
 * carrier" radius-count proxy, and small formatting helpers used by
 * both the /crm leads table and the LeadDetailDrawer.
 *
 * Palette follows the app's existing tint families (see the bucket
 * tiles in app/accounting/page.tsx): opaque-ish tint for text, 8-12%
 * light tint for chip backgrounds.
 */

import type { CrmLead, CrmLeadStatus } from '@fleetcal/types';

export const STATUS_META: Record<CrmLeadStatus, { label: string; tint: string; tintLight: string }> = {
  new:            { label: 'New',            tint: '#455a64', tintLight: '#eceff1' },
  enriched:       { label: 'Enriched',       tint: '#1a73e8', tintLight: '#e8f0fe' },
  queued:         { label: 'Queued',         tint: '#7b1fa2', tintLight: '#f3e8fd' },
  emailing:       { label: 'Emailing',       tint: '#3730a3', tintLight: '#eef2ff' },
  call_queue:     { label: 'Call queue',     tint: '#e37400', tintLight: '#fef3e2' },
  interested:     { label: 'Interested',     tint: '#00838f', tintLight: '#e0f7fa' },
  demo_scheduled: { label: 'Demo scheduled', tint: '#c2185b', tintLight: '#fce4ec' },
  won:            { label: 'Won',            tint: '#188038', tintLight: '#e6f4ea' },
  lost:           { label: 'Lost',           tint: '#c5221f', tintLight: '#fee2e2' },
  unsubscribed:   { label: 'Unsubscribed',   tint: '#9a3412', tintLight: '#fed7aa' },
  do_not_contact: { label: 'Do not contact', tint: '#991b1b', tintLight: '#fee2e2' },
  disqualified:   { label: 'Disqualified',   tint: '#5f6368', tintLight: '#f1f3f4' },
};

export function StatusChip({ status }: { status: CrmLeadStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.new;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-[10.5px] font-extrabold whitespace-nowrap"
      style={{ background: meta.tintLight, color: meta.tint }}>
      {meta.label}
    </span>
  );
}

/** MCS-150 operation-class labels. A/B/C per the census spec. */
export const OPERATION_CLASS_LABELS: Record<string, string> = {
  A: 'Interstate',
  B: 'Intrastate HM',
  C: 'Intrastate non-HM',
};

/**
 * "Local" ICP proxy — MCS-150 haul-radius DRIVER COUNTS (verified
 * 2026-07-02: numeric counts, not Y/N flags). Local = some within-100
 * drivers AND zero/null beyond-100 drivers. Mirrors the server-side
 * filter in apps/api/src/routes/crm.ts (local=true).
 */
export function isLocalLead(l: CrmLead): boolean {
  const within = (l.interstateWithin100 ?? 0) + (l.intrastateWithin100 ?? 0);
  const beyond = (l.interstateBeyond100 ?? 0) + (l.intrastateBeyond100 ?? 0);
  return within > 0 && beyond === 0;
}

/** Relative timestamp for the activity timeline: "just now", "5m ago",
 *  "3h ago", "2d ago", then a short absolute date beyond a week. */
export function fmtRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
