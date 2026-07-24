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

import type { CrmCallOutcome, CrmEmailVerificationStatus, CrmLead, CrmLeadStatus } from '@fleetcal/types';
import { ShieldCheck, ShieldAlert, ShieldOff, HelpCircle } from 'lucide-react';
import { FastTooltip } from '@/components/queue/QueueTablePrimitives';

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

/** Small verification badge shown next to a lead's email icon. Only
 *  `valid` addresses may be enrolled in outreach; everything else
 *  routes to the call queue by the verifier. Unverified renders as a
 *  neutral hint so a batch that hasn't been run yet is obvious. */
export function VerificationBadge({
  status,
}: { status?: CrmEmailVerificationStatus | null }) {
  if (!status) {
    return (
      <FastTooltip text="Email not yet verified. Click 'Verify 100' to batch-check.">
        <HelpCircle size={12} style={{ color: 'var(--gc-text-3)', opacity: 0.6 }} />
      </FastTooltip>
    );
  }
  if (status === 'valid') {
    return (
      <FastTooltip text="Email verified — safe to enroll in outreach.">
        <ShieldCheck size={12} style={{ color: '#188038' }} />
      </FastTooltip>
    );
  }
  const map: Record<Exclude<CrmEmailVerificationStatus, 'valid'>, { icon: React.ReactNode; label: string }> = {
    invalid:    { icon: <ShieldOff   size={12} style={{ color: '#c5221f' }} />, label: 'Invalid — will hard-bounce. Routed to call queue.' },
    disposable: { icon: <ShieldOff   size={12} style={{ color: '#c5221f' }} />, label: 'Disposable / temporary address. Routed to call queue.' },
    catchall:   { icon: <ShieldAlert size={12} style={{ color: '#e37400' }} />, label: 'Catchall domain — delivery uncertain. Routed to call queue.' },
    unknown:    { icon: <ShieldAlert size={12} style={{ color: '#e37400' }} />, label: 'Unknown — provider could not verify. Routed to call queue; can retry.' },
  };
  const meta = map[status];
  return <FastTooltip text={meta.label}>{meta.icon}</FastTooltip>;
}

/** Call-outcome palette + labels, mirroring STATUS_META's tint family.
 *  `short` is used in the tight leads-list Contact column. */
export const OUTCOME_META: Record<CrmCallOutcome, { label: string; short: string; tint: string; tintLight: string }> = {
  no_answer:      { label: 'No answer',      short: 'No answer',  tint: '#5f6368', tintLight: '#f1f3f4' },
  voicemail:      { label: 'Voicemail',      short: 'Voicemail',  tint: '#1a73e8', tintLight: '#e8f0fe' },
  bad_number:     { label: 'Bad number',     short: 'Bad #',      tint: '#c5221f', tintLight: '#fee2e2' },
  not_interested: { label: 'Not interested', short: 'Not int.',   tint: '#9a3412', tintLight: '#fed7aa' },
  interested:     { label: 'Interested',     short: 'Interested', tint: '#188038', tintLight: '#e6f4ea' },
  demo_scheduled: { label: 'Demo scheduled', short: 'Demo',       tint: '#c2185b', tintLight: '#fce4ec' },
};

/** Compact badge for a logged call outcome (leads-list Contact column,
 *  drawer timeline). */
export function OutcomeBadge({ outcome }: { outcome: CrmCallOutcome }) {
  const m = OUTCOME_META[outcome];
  if (!m) return null;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap"
      style={{ background: m.tintLight, color: m.tint }}>
      {m.short}
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
