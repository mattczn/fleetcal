'use client';

/**
 * Shared load-history module — BUILD one side, RENDER the other.
 *
 * Every surface that shows `LoadAuditEntry` history renders through this
 * module — EventModal's history panel and the load detail page's
 * LoadHistorySection. The category→colour map and the entry→lines logic
 * live here ONCE: a colour table copied into two files is exactly the
 * kind of thing that drifts, and this history has already drifted (the
 * detail page was silently missing truck, trailer, stop, relay, status,
 * document and check-in lines).
 *
 * The DIFFER (`buildAuditEntry` + `diffAccessorials` + `appendAuditEntry`)
 * now lives here too. It used to be a closure inside EventModal, which is
 * why EventModal was the only screen in the app that logged anything: the
 * payroll page's inline pay editor and the load detail page's pay/price
 * saves had no differ they could reach, so they wrote money changes with
 * no history at all. A pay badge on top of that would have LIED — a
 * manual override typed on the payroll page would have left the last
 * logged entry still saying "auto". One differ, three call sites.
 *
 * Shape: ONE LINE PER CHANGE. A save touching three fields produces
 * three lines, each with its own category badge, optional leg chip and
 * attribution. That's what makes the badges legible — the previous
 * "&"-joined single line had no room for them.
 */

import type { ReactNode } from 'react';
import type { Accessorial, AccessorialChange, LoadAuditEntry } from '@fleetcal/types';

// ── Categories ───────────────────────────────────────────────────────

export type AuditCategory =
  | 'created'
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
  created:    { bg: '#E8EFEA', fg: '#1F4A32', label: 'Created' },
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

/** Which category's tint each pay source borrows. Deliberately NOT a
 *  second colour table — AUDIT_CATEGORY_STYLE stays the only one, so a
 *  palette change can't leave the pay badges behind.
 *
 *  'manual' takes the Financial tint because a human deciding a pay
 *  figure is the noteworthy event; 'auto' takes the muted Status tint
 *  because the app doing what it was configured to do is the boring
 *  default. */
/** Human phrasing for each creation origin. Reads as the tail of
 *  "Load created …", so each entry is a prepositional phrase, not a
 *  noun. 'api' stays deliberately vague — it's the fallback for a
 *  client that sent no origin, and inventing a specific one there would
 *  put a guess in an audit log. */
const CREATED_VIA_LABEL: Record<
  NonNullable<LoadAuditEntry['createdVia']>['method'],
  string
> = {
  manual:      'by hand',
  drag:        'by dragging on the calendar',
  duplicate:   'as a duplicate',
  plus_week:   'with +1 Week',
  rate_con_ai: 'by Rate Con AI',
  split_relay: 'by splitting a relay leg',
  import:      'by a bulk import',
  bot:         'from the dispatch bot',
  api:         'via the API',
};

const PAY_SOURCE_TINT: Record<'auto' | 'manual', AuditCategory> = {
  auto:   'status',
  manual: 'financial',
};

const PAY_SOURCE_LABEL: Record<'auto' | 'manual', string> = {
  auto:   'Auto',
  manual: 'Manual',
};

/** "Auto" / "Manual" marker for a driver-pay line — says what DETERMINED
 *  the number. Entries written before `paySource` existed have no value
 *  and render with no badge at all; the caller must not substitute a
 *  guess (see the field's doc comment in packages/types/domain.ts). */
export function PaySourceBadge({ source }: { source: 'auto' | 'manual' }) {
  const s = AUDIT_CATEGORY_STYLE[PAY_SOURCE_TINT[source]];
  return (
    <span
      title={source === 'auto'
        ? 'Set automatically from the org’s driver-pay percentage'
        : 'Typed in by a person'}
      style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
        padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
        background: s.bg, color: s.fg, flexShrink: 0,
      }}>
      {PAY_SOURCE_LABEL[source]}
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

  // ── Created ──
  // First, so a load's history opens with where it came from. Only ever
  // written once, by the server, at create time.
  if (entry.createdVia) {
    const { method, sourceLoadNum, fileName } = entry.createdVia;
    const from =
      sourceLoadNum ? <> from {b(sourceLoadNum)}</>
      : fileName    ? <> from {b(fileName)}</>
      : null;
    push('created', 'created', <>{b('Load created')} {CREATED_VIA_LABEL[method] ?? method}{from}</>);
  }

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
  // The pay badge rides on THIS line only. `paySource` describes the
  // driver-pay pair, never the load price sitting in the same entry.
  if (entry.prevDriverPay !== undefined || entry.newDriverPay !== undefined)
    push('dpay', 'financial', <>
      {b('Driver pay')} changed from {b(fmt$(entry.prevDriverPay))} to {b(fmt$(entry.newDriverPay))}
      {entry.paySource ? <> <PaySourceBadge source={entry.paySource} /></> : null}
    </>);
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

// ── The differ (moved verbatim out of EventModal) ────────────────────
//
// These three functions were private to EventModal. Every other screen
// that changes a load therefore wrote NO history — see the module
// header. They are pure: everything they need arrives as a parameter,
// which is what made the move mechanical.

/**
 * The minimum shape the differ reads off "the row as it is now". Both
 * the web's `CalendarEvent` and the API's `Load` satisfy it structurally,
 * so the calendar modal, the load detail page and the payroll page can
 * all feed it their own object without a conversion step.
 */
export interface AuditSubject {
  driverName?:   string;
  assetId:       number;
  loadPrice?:    number;
  driverPay?:    number;
  stops?:        ReadonlyArray<unknown>;
  accessorials?: Accessorial[];
  broker?:       string;
  customerId?:   string;
  dispatcher?:   string;
  trailerId?:    number;
  priority?:     boolean;
  start?:        string;
  end?:          string;
}

/** The "what it's becoming" half of the diff. EVERY field must be
 *  supplied with its current value even when it isn't changing —
 *  `undefined` reads as "cleared", not "untouched". `auditSubjectAsNext`
 *  builds the no-op baseline for callers that only touch one field. */
export interface AuditNext {
  assetId:          number;
  driverName?:      string;
  newLoadPrice?:    number;
  newDriverPay?:    number;
  newStopCount:     number;
  newAccessorials?: Accessorial[];
  relayCreated?:    boolean;
  newBroker?:       string;
  newCustomerId?:   string;
  newCustomerName?: string;
  newDispatcher?:   string;
  newTrailerId?:    number;
  newTrailerNum?:   string;
  newPriority?:     boolean;
  newStart?:        string;
  newEnd?:          string;
  /** Only meaningful when the driver-pay figure actually moves; dropped
   *  otherwise. Pass what the WRITING SITE knows — 'auto' for a
   *  percentage-derived fill, 'manual' for a human-typed one. Never
   *  derive it from payMatchesPct(). */
  paySource?:       'auto' | 'manual';
}

/**
 * A `next` that changes NOTHING — the subject's own values, mirrored
 * into the differ's vocabulary. Spread it and override the one or two
 * fields a screen actually edits:
 *
 *   buildAuditEntry(leg, { ...auditSubjectAsNext(leg), newDriverPay: v,
 *                          paySource: 'manual' }, {}, who)
 *
 * Without this, a pay-only caller has to hand-copy thirteen fields and
 * one omission silently logs a phantom "Customer changed to —".
 */
export function auditSubjectAsNext(subject: AuditSubject): AuditNext {
  return {
    assetId:          subject.assetId,
    driverName:       subject.driverName,
    newLoadPrice:     subject.loadPrice,
    newDriverPay:     subject.driverPay,
    newStopCount:     subject.stops?.length ?? 0,
    newAccessorials:  subject.accessorials,
    newBroker:        subject.broker,
    newCustomerId:    subject.customerId,
    newDispatcher:    subject.dispatcher,
    newTrailerId:     subject.trailerId,
    newPriority:      subject.priority,
    newStart:         subject.start,
    newEnd:           subject.end,
  };
}

/**
 * Mirrors apps/api/src/routes/loads.ts::diffAccessorialsForAudit so an
 * EventModal save and a /v1/loads PATCH from the load-detail page
 * produce structurally identical AccessorialChange[] entries. If you
 * extend the comparable field set here, also extend the server helper —
 * the two have to stay in sync or audit history will look different
 * depending on which surface edited the row.
 */
export function diffAccessorials(prev: Accessorial[] = [], next: Accessorial[] = []): AccessorialChange[] {
  const changes: AccessorialChange[] = [];
  const prevMap = new Map(prev.map(a => [a.id, a]));
  const nextMap = new Map(next.map(a => [a.id, a]));
  for (const [id, a] of nextMap) {
    if (!prevMap.has(id)) {
      changes.push({
        action: 'added', id,
        category: a.category, description: a.description, amount: a.amount,
        newStatus:        a.status,
        newBillable:      a.billable,
        newPayToDriver:   a.payToDriver,
        newPayDriverName: a.payDriverName,
      });
    } else {
      const p = prevMap.get(id)!;
      const amountChanged       = (p.amount ?? 0) !== (a.amount ?? 0);
      const statusChanged       = (p.status ?? '') !== (a.status ?? '');
      const billableChanged     = !!p.billable     !== !!a.billable;
      const payToDriverChanged  = !!p.payToDriver  !== !!a.payToDriver;
      const payNameChanged      = (p.payDriverName ?? '') !== (a.payDriverName ?? '');
      const categoryChanged     = (p.category      ?? '') !== (a.category      ?? '');
      const descriptionChanged  = (p.description   ?? '') !== (a.description   ?? '');
      if (amountChanged || statusChanged || billableChanged || payToDriverChanged
          || payNameChanged || categoryChanged || descriptionChanged) {
        changes.push({
          action: 'updated', id,
          category: a.category, description: a.description,
          ...(amountChanged       ? { prevAmount: p.amount, amount: a.amount } : {}),
          ...(statusChanged       ? { prevStatus: p.status, newStatus: a.status } : {}),
          ...(billableChanged     ? { prevBillable: !!p.billable, newBillable: !!a.billable } : {}),
          ...(payToDriverChanged  ? { prevPayToDriver: !!p.payToDriver, newPayToDriver: !!a.payToDriver } : {}),
          ...(payNameChanged      ? { prevPayDriverName: p.payDriverName, newPayDriverName: a.payDriverName } : {}),
          ...(categoryChanged     ? { prevCategory: p.category } : {}),
          ...(descriptionChanged  ? { prevDescription: p.description, newDescription: a.description } : {}),
        });
      }
    }
  }
  for (const [id, a] of prevMap) {
    if (!nextMap.has(id)) {
      changes.push({
        action: 'removed', id,
        category: a.category, description: a.description, amount: a.amount,
        prevStatus:        a.status,
        prevBillable:      a.billable,
        prevPayToDriver:   a.payToDriver,
        prevPayDriverName: a.payDriverName,
      });
    }
  }
  return changes;
}

export function buildAuditEntry(
  existing: AuditSubject,
  next: AuditNext,
  // Callers resolve readable display names for any ID-typed fields
  // before invoking — the audit log is fetched later without the
  // customers / trailers lists in scope, so storing raw IDs alone
  // would render as opaque uuids. See EventModal's doSave caller for
  // the lookup pattern (find by id in customers / trailers arrays).
  prevNames: { customerName?: string; trailerNum?: string },
  byName: string,
): LoadAuditEntry | null {
  const driverChanged    = (existing.driverName ?? '') !== (next.driverName ?? '');
  const assetChanged     = existing.assetId !== next.assetId;
  const loadPriceChanged = (existing.loadPrice ?? 0) !== (next.newLoadPrice ?? 0) && (existing.loadPrice != null || next.newLoadPrice != null);
  const driverPayChanged = (existing.driverPay ?? 0) !== (next.newDriverPay ?? 0) && (existing.driverPay != null || next.newDriverPay != null);
  const prevStopCount    = existing.stops?.length ?? 0;
  const stopsAdded       = Math.max(0, next.newStopCount - prevStopCount);
  const stopsRemoved     = Math.max(0, prevStopCount - next.newStopCount);
  const accessorialsChanged = diffAccessorials(existing.accessorials, next.newAccessorials);

  // Each is gated on (a) the field actually changing AND (b) at least
  // one side being defined — a load with no broker that gets saved as
  // no broker shouldn't write an entry just because the
  // empty-vs-undefined coercion differs.
  const brokerChanged     = (existing.broker ?? '') !== (next.newBroker ?? '') && (existing.broker || next.newBroker);
  const customerIdChanged = (existing.customerId ?? '') !== (next.newCustomerId ?? '') && (existing.customerId || next.newCustomerId);
  const dispatcherChanged = (existing.dispatcher ?? '') !== (next.newDispatcher ?? '') && (existing.dispatcher || next.newDispatcher);
  const trailerIdChanged  = (existing.trailerId ?? null) !== (next.newTrailerId ?? null);
  const priorityChanged   = !!existing.priority !== !!next.newPriority;
  const startChanged      = (existing.start ?? '') !== (next.newStart ?? '') && (existing.start || next.newStart);
  const endChanged        = (existing.end   ?? '') !== (next.newEnd   ?? '') && (existing.end   || next.newEnd);

  const hasChanges =
    driverChanged || assetChanged || loadPriceChanged || driverPayChanged ||
    stopsAdded > 0 || stopsRemoved > 0 || next.relayCreated ||
    accessorialsChanged.length > 0 ||
    brokerChanged || customerIdChanged || dispatcherChanged ||
    trailerIdChanged || priorityChanged || startChanged || endChanged;
  if (!hasChanges) return null;

  return {
    changedAt: new Date().toISOString(),
    changedByName: byName,
    ...(driverChanged          ? { prevDriverName: existing.driverName,  newDriverName: next.driverName }   : {}),
    ...(assetChanged           ? { prevAssetId:    existing.assetId,     newAssetId:    next.assetId }       : {}),
    ...(loadPriceChanged       ? { prevLoadPrice:  existing.loadPrice,   newLoadPrice:  next.newLoadPrice }  : {}),
    // paySource rides ONLY with a real pay movement. An entry that
    // changes the load price but leaves pay alone must not carry it.
    ...(driverPayChanged       ? {
      prevDriverPay: existing.driverPay,
      newDriverPay:  next.newDriverPay,
      ...(next.paySource ? { paySource: next.paySource } : {}),
    } : {}),
    ...(brokerChanged          ? { prevBroker:     existing.broker,      newBroker:     next.newBroker }     : {}),
    ...(customerIdChanged      ? {
      prevCustomerId:   existing.customerId,
      newCustomerId:    next.newCustomerId,
      prevCustomerName: prevNames.customerName,
      newCustomerName:  next.newCustomerName,
    } : {}),
    ...(dispatcherChanged      ? { prevDispatcher: existing.dispatcher,  newDispatcher: next.newDispatcher } : {}),
    ...(trailerIdChanged       ? {
      prevTrailerId:  existing.trailerId,
      newTrailerId:   next.newTrailerId,
      prevTrailerNum: prevNames.trailerNum,
      newTrailerNum:  next.newTrailerNum,
    } : {}),
    ...(priorityChanged        ? { prevPriority: !!existing.priority, newPriority: !!next.newPriority }       : {}),
    ...(startChanged           ? { prevStart: existing.start, newStart: next.newStart }                       : {}),
    ...(endChanged             ? { prevEnd:   existing.end,   newEnd:   next.newEnd }                         : {}),
    ...(stopsAdded   > 0       ? { stopsAdded }   : {}),
    ...(stopsRemoved > 0       ? { stopsRemoved } : {}),
    ...(next.relayCreated      ? { relayCreated: true } : {}),
    ...(accessorialsChanged.length > 0 ? { accessorialsChanged } : {}),
  };
}

export function appendAuditEntry(
  existing: LoadAuditEntry[] | undefined,
  entry: LoadAuditEntry | null,
): LoadAuditEntry[] {
  if (!entry) return existing ?? [];
  return [...(existing ?? []), entry];
}

/**
 * What determined the pay figure a leg is CARRYING RIGHT NOW, read back
 * out of history — for surfaces that want to mark the live value, not
 * just the change list.
 *
 * Three deliberate refusals:
 *   • Entries with no `paySource` are skipped, and if none is found the
 *     answer is `undefined` — render nothing. Everything written before
 *     this field existed has unknown provenance, and unknown must not
 *     be drawn as "auto".
 *   • A leg-chipped entry only answers for ITS leg. An unchipped entry
 *     is load-level, which on a single-leg load is the same thing.
 *   • The newest sourced entry only counts when its `newDriverPay` still
 *     matches the current figure. If something moved the number since
 *     (a server auto-fill, an import, a path that doesn't log yet), the
 *     badge would be describing a value that is no longer on screen.
 */
export function latestPaySource(
  log: LoadAuditEntry[] | undefined,
  opts: { legIndex?: number; currentPay?: number },
): 'auto' | 'manual' | undefined {
  if (!log?.length) return undefined;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (!e.paySource) continue;
    if (e.prevDriverPay === undefined && e.newDriverPay === undefined) continue;
    if (e.leg && opts.legIndex != null && e.leg.index !== opts.legIndex) continue;
    const paid = opts.currentPay;
    if (paid == null || e.newDriverPay == null) return undefined;
    return Math.abs(e.newDriverPay - paid) < 0.005 ? e.paySource : undefined;
  }
  return undefined;
}
