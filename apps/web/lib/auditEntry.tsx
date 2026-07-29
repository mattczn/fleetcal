'use client';

/**
 * Shared load-history renderer.
 *
 * Every surface that shows `LoadAuditEntry` history renders through this
 * module — EventModal's history panel and the load detail page's
 * LoadHistorySection. The category→colour map and the entry→lines logic
 * live here ONCE: a colour table copied into two files is exactly the
 * kind of thing that drifts, and this history has already drifted (the
 * detail page was silently missing truck, trailer, stop, relay, status,
 * document and check-in lines).
 *
 * Shape: ONE LINE PER CHANGE. A save touching three fields produces
 * three lines, each with its own category badge, optional leg chip and
 * attribution. That's what makes the badges legible — the previous
 * "&"-joined single line had no room for them.
 */

import type { ReactNode } from 'react';
import type { LoadAuditEntry } from '@fleetcal/types';

// ── Categories ───────────────────────────────────────────────────────

export type AuditCategory =
  | 'relay'
  | 'assignment'
  | 'schedule'
  | 'financial'
  | 'document'
  | 'customer'
  | 'stops'
  | 'status'
  | 'cancelled';

/** Approved tints. Text uses the dark tone of the pair — never grey on
 *  tint, which fails contrast on these light backgrounds. */
export const AUDIT_CATEGORY_STYLE: Record<AuditCategory, { bg: string; fg: string; label: string }> = {
  relay:      { bg: '#EEEDFE', fg: '#3C3489', label: 'Relay' },
  assignment: { bg: '#E6F1FB', fg: '#0C447C', label: 'Assignment' },
  schedule:   { bg: '#FAEEDA', fg: '#633806', label: 'Schedule' },
  financial:  { bg: '#EAF3DE', fg: '#27500A', label: 'Financial' },
  document:   { bg: '#E1F5EE', fg: '#085041', label: 'Document' },
  customer:   { bg: '#FBEAF0', fg: '#72243E', label: 'Customer' },
  stops:      { bg: '#FAECE7', fg: '#712B13', label: 'Stops' },
  status:     { bg: '#F1EFE8', fg: '#2C2C2A', label: 'Status' },
  cancelled:  { bg: '#FCEBEB', fg: '#791F1F', label: 'Cancelled' },
};

/** Category badge — same pill shape/size as the leg chip it sits beside. */
export function AuditBadge({ category }: { category: AuditCategory }) {
  const s = AUDIT_CATEGORY_STYLE[category] ?? AUDIT_CATEGORY_STYLE.status;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
      padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
      background: s.bg, color: s.fg, flexShrink: 0,
    }}>
      {s.label}
    </span>
  );
}

/** The leg chip, unchanged in look — kept SEPARATE from the category
 *  badge and rendered after it. */
export function AuditLegChip({ leg }: { leg: NonNullable<LoadAuditEntry['leg']> }) {
  const label = leg.label
    ?? (leg.count ? `Leg ${leg.index + 1}/${leg.count}` : `Leg ${leg.index + 1}`);
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
      padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
      background: '#ede9fe', color: '#7c3aed', border: '1px solid #ddd6fe', flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

// ── Formatting helpers (the existing behaviour, centralised) ─────────

export interface AuditRenderCtx {
  /** IANA zone the org reads times in. */
  timeZone: string;
  /** Resolves an assetId to a truck name. Optional: the load detail
   *  page has no asset list, and without it truck lines used to be
   *  dropped entirely rather than degraded. */
  assetName?: (id: number) => string;
}

const b = (v: ReactNode) => <strong style={{ fontWeight: 600 }}>{v}</strong>;
const fmt$ = (n?: number) => (n != null ? `$${n.toLocaleString()}` : '—');
const fmtCat = (s?: string) => (s ? s.replace(/_/g, ' ') : '');

/** Full timestamp for the attribution, in the org's zone. */
export function fmtAuditDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone,
  });
}

/** prevStart/newStart etc. are NAIVE ISO ("YYYY-MM-DDTHH:mm") already
 *  in the org's wall-clock. Parsing as UTC and formatting with the org
 *  zone would double-shift, so the parts are formatted directly. */
export function fmtAuditTime(iso?: string): string {
  if (!iso) return '—';
  const s = iso.includes(' ') ? iso.replace(' ', 'T') : iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
  return dt.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  });
}

// ── Entry → lines ────────────────────────────────────────────────────

export interface AuditLine {
  key: string;
  category: AuditCategory;
  node: ReactNode;
}

/**
 * Expand one entry into its individual changes. Superset of what the
 * two call sites rendered separately — including the richer accessorial
 * sub-change wording that only the detail page had, and the truck /
 * trailer / stop / relay / status / document / check-in lines that only
 * EventModal had.
 */
export function buildAuditLines(entry: LoadAuditEntry, ctx: AuditRenderCtx): AuditLine[] {
  const out: AuditLine[] = [];
  const push = (key: string, category: AuditCategory, node: ReactNode) => out.push({ key, category, node });
  const assetName = (id?: number) =>
    id == null ? '—' : (ctx.assetName?.(id) ?? `Asset ${id}`);

  // ── Assignment ──
  if (entry.prevAssetId !== undefined || entry.newAssetId !== undefined)
    push('asset', 'assignment', <>{b('Truck')} changed from {b(assetName(entry.prevAssetId))} to {b(assetName(entry.newAssetId))}</>);
  if (entry.prevDriverName !== undefined || entry.newDriverName !== undefined)
    push('driver', 'assignment', <>{b('Driver')} changed from {b(entry.prevDriverName || '—')} to {b(entry.newDriverName || '—')}</>);
  if (entry.prevTrailerId !== undefined || entry.newTrailerId !== undefined)
    push('trailer', 'assignment', <>{b('Trailer')} changed from {b(entry.prevTrailerNum || (entry.prevTrailerId ? `#${entry.prevTrailerId}` : '—'))} to {b(entry.newTrailerNum || (entry.newTrailerId ? `#${entry.newTrailerId}` : '—'))}</>);

  // ── Financial ──
  if (entry.prevLoadPrice !== undefined || entry.newLoadPrice !== undefined)
    push('lprice', 'financial', <>{b('Load price')} changed from {b(fmt$(entry.prevLoadPrice))} to {b(fmt$(entry.newLoadPrice))}</>);
  if (entry.prevDriverPay !== undefined || entry.newDriverPay !== undefined)
    push('dpay', 'financial', <>{b('Driver pay')} changed from {b(fmt$(entry.prevDriverPay))} to {b(fmt$(entry.newDriverPay))}</>);
  if (entry.prevBillingStatus !== undefined || entry.newBillingStatus !== undefined)
    push('billing', 'financial', <>{b('Billing status')} changed from {b(fmtCat(entry.prevBillingStatus) || '—')} to {b(fmtCat(entry.newBillingStatus) || '—')}</>);

  // ── Customer ──
  if (entry.prevCustomerId !== undefined || entry.newCustomerId !== undefined)
    push('customer', 'customer', <>{b('Customer')} changed from {b(entry.prevCustomerName || entry.prevBroker || '—')} to {b(entry.newCustomerName || entry.newBroker || '—')}</>);
  else if (entry.prevBroker !== undefined || entry.newBroker !== undefined)
    push('broker', 'customer', <>{b('Customer')} changed from {b(entry.prevBroker || '—')} to {b(entry.newBroker || '—')}</>);
  if (entry.prevDispatcher !== undefined || entry.newDispatcher !== undefined)
    push('disp', 'customer', <>{b('Dispatcher')} changed from {b(entry.prevDispatcher || '—')} to {b(entry.newDispatcher || '—')}</>);

  // ── Schedule ──
  if (entry.prevStart !== undefined || entry.newStart !== undefined)
    push('start', 'schedule', <>{b('Start')} changed from {b(fmtAuditTime(entry.prevStart))} to {b(fmtAuditTime(entry.newStart))}</>);
  if (entry.prevEnd !== undefined || entry.newEnd !== undefined)
    push('end', 'schedule', <>{b('End')} changed from {b(fmtAuditTime(entry.prevEnd))} to {b(fmtAuditTime(entry.newEnd))}</>);

  // ── Status ──
  if (entry.prevPriority !== undefined || entry.newPriority !== undefined)
    push('priority', 'status', <>{b('Priority')} {entry.newPriority ? <>flagged {b('on')}</> : <>flag {b('removed')}</>}</>);
  if (!entry.loadCancelled && (entry.prevStatus !== undefined || entry.newStatus !== undefined))
    push('status', 'status', <>{b('Status')} changed from {b(fmtCat(entry.prevStatus) || '—')} to {b(fmtCat(entry.newStatus) || '—')}</>);
  if (entry.loadConfirmed)
    push('confirmed', 'status', <>Load {b('confirmed')} by the driver</>);
  if (entry.confirmPushSent)
    push('cpush', 'status', <>{b('Confirmation request')} sent to the driver</>);

  // ── Stops ──
  if (entry.stopsAdded)
    push('sadd', 'stops', <>{b(String(entry.stopsAdded))} stop{entry.stopsAdded > 1 ? 's' : ''} added</>);
  if (entry.stopsRemoved)
    push('srem', 'stops', <>{b(String(entry.stopsRemoved))} stop{entry.stopsRemoved > 1 ? 's' : ''} removed</>);
  if (entry.stopCheckedIn) {
    const ci = entry.stopCheckedIn;
    push('ci', 'stops', <>
      Driver {b('checked in')}{ci.stopType ? <> at {b(fmtCat(ci.stopType))}</> : null}
      {ci.stopFacility ? <> — {b(ci.stopFacility)}</> : null}
      {ci.distanceMi != null ? <> ({ci.distanceMi.toFixed(1)} mi away)</> : null}
    </>);
  }

  // ── Documents ──
  if (entry.documentUploaded)
    push('dup', 'document', <>
      {b('Document')} uploaded: {b(entry.documentUploaded.fileName)}
      {entry.documentUploaded.kind ? <> ({fmtCat(entry.documentUploaded.kind)})</> : null}
    </>);
  if (entry.documentDeleted)
    push('ddel', 'document', <>
      {b('Document')} deleted: {b(entry.documentDeleted.fileName)}
      {entry.documentDeleted.kind ? <> ({fmtCat(entry.documentDeleted.kind)})</> : null}
    </>);

  // ── Relay (structural) ──
  const rh = entry.relayHandoff;
  if (rh?.action === 'added') {
    push('rhadd', 'relay', <>
      {b(`Handoff ${rh.index + 1}`)} added{rh.location ? <> at {b(rh.location)}</> : null}
      {rh.legLabel ? <> — {b(rh.legLabel)} created{rh.driverName ? <> for {b(rh.driverName)}</> : null}</> : null}
    </>);
  } else if (rh?.action === 'removed') {
    push('rhrem', 'relay', <>
      {b(`Handoff ${rh.index + 1}`)} removed{rh.prevLocation ? <> at {b(rh.prevLocation)}</> : null}
      {rh.legLabel ? <> — {b(rh.legLabel)} merged away{rh.driverName ? <> (was {b(rh.driverName)})</> : null}</> : null}
    </>);
  } else if (rh?.action === 'moved') {
    if (rh.prevLocation !== undefined || rh.location !== undefined)
      push('rhloc', 'relay', <>{b(`Handoff ${rh.index + 1}`)} moved from {b(rh.prevLocation || '—')} to {b(rh.location || '—')}</>);
    if (rh.prevDropAt !== undefined || rh.newDropAt !== undefined)
      push('rhdrop', 'relay', <>{b(`Handoff ${rh.index + 1}`)} drop changed from {b(fmtAuditTime(rh.prevDropAt))} to {b(fmtAuditTime(rh.newDropAt))}</>);
    if (rh.prevPickupAt !== undefined || rh.newPickupAt !== undefined)
      push('rhpick', 'relay', <>{b(`Handoff ${rh.index + 1}`)} pickup changed from {b(fmtAuditTime(rh.prevPickupAt))} to {b(fmtAuditTime(rh.newPickupAt))}</>);
  } else {
    // Pre-relayHandoff entries kept their booleans.
    if (entry.relayCreated) push('rcreate', 'relay', <>Load split as {b('relay')}</>);
    if (entry.relayRemoved) push('rremove', 'relay', <>{b('Relay')} removed, load merged</>);
  }

  // ── Cancelled / deleted / restored ──
  if (entry.loadCancelled) {
    const mode = entry.loadCancelled.mode;
    const modeLabel = mode === 'status' ? 'marked cancelled'
      : mode === 'remove-event' ? 'cancelled and removed from the calendar'
      : 'cancelled and deleted';
    push('cancelled', 'cancelled', <>
      {b('Load')} {modeLabel}
      {entry.loadCancelled.reason ? <> — {b(entry.loadCancelled.reason)}</> : null}
    </>);
  }
  if (entry.loadDeleted && !entry.loadCancelled)
    push('ldel', 'cancelled', <>{b('Load')} deleted</>);
  if (entry.loadRestored || entry.loadReinstated)
    push('lrest', 'cancelled', <>{b('Load')} reinstated</>);

  // ── Accessorials (the detail page's richer wording, superset) ──
  for (const [ai, ac] of (entry.accessorialsChanged ?? []).entries()) {
    const label = `${fmtCat(ac.category)}${ac.description ? ` (${ac.description})` : ''}`;
    const sub: string[] = [];
    if (ac.prevStatus !== undefined || ac.newStatus !== undefined)
      sub.push(`status ${fmtCat(ac.prevStatus) || '—'} → ${fmtCat(ac.newStatus) || '—'}`);
    if (ac.prevBillable !== undefined || ac.newBillable !== undefined)
      sub.push(`billable ${ac.prevBillable ? 'on' : 'off'} → ${ac.newBillable ? 'on' : 'off'}`);
    if (ac.prevPayToDriver !== undefined || ac.newPayToDriver !== undefined)
      sub.push(`pay to driver ${ac.prevPayToDriver ? 'on' : 'off'} → ${ac.newPayToDriver ? 'on' : 'off'}`);
    if (ac.prevPayDriverName !== undefined || ac.newPayDriverName !== undefined)
      sub.push(`paid driver ${ac.prevPayDriverName || '—'} → ${ac.newPayDriverName || '—'}`);
    if (ac.prevCategory !== undefined)
      sub.push(`category ${fmtCat(ac.prevCategory)} → ${fmtCat(ac.category)}`);
    if (ac.prevDescription !== undefined || ac.newDescription !== undefined)
      sub.push(`description ${ac.prevDescription || '—'} → ${ac.newDescription || '—'}`);
    if (ac.prevAmount !== undefined || ac.amount !== undefined)
      sub.push(`${fmt$(ac.prevAmount)} → ${fmt$(ac.amount)}`);

    const verb = ac.action === 'added' ? 'added' : ac.action === 'removed' ? 'removed' : 'updated';
    push(`acc-${ai}`, 'financial', <>
      {b(`${label} accessorial ${verb}`)}
      {ac.action === 'removed' && ac.amount != null ? <> · was {fmt$(ac.amount)}</> : null}
      {sub.length > 0 ? <> · {sub.join('; ')}</> : null}
    </>);
  }

  return out;
}

// ── Entry component ─────────────────────────────────────────────────

/**
 * Renders one audit entry as N lines — `[Category] [Leg?] change · by
 * who · when`. Emits nothing when the entry produces no lines (the
 * detail page already hid those; EventModal used to leave an empty row).
 */
export function AuditEntryLines({
  entry, ctx,
}: {
  entry: LoadAuditEntry;
  ctx: AuditRenderCtx;
}) {
  const lines = buildAuditLines(entry, ctx);
  if (lines.length === 0) return null;
  const who = entry.changedByName || 'Unknown';
  const when = fmtAuditDate(entry.changedAt, ctx.timeZone);
  return (
    <>
      {lines.map(line => (
        <div key={line.key}
          style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, flexWrap: 'wrap' }}>
          <AuditBadge category={line.category} />
          {entry.leg && <AuditLegChip leg={entry.leg} />}
          <span style={{ color: 'var(--gc-text-1)' }}>{line.node}</span>
          <span style={{ color: 'var(--gc-text-3)', whiteSpace: 'nowrap' }}>· by {who} · {when}</span>
        </div>
      ))}
    </>
  );
}
