/**
 * Payroll snapshot — building and diffing the frozen detail of a
 * finalized week.
 *
 * A finalized payroll week must show the same numbers tomorrow as the
 * day it was issued. That is only possible if Finalize records the
 * LINES, not just the total: the total alone can't reprint a stub, can't
 * survive a load being edited or moved across the Saturday boundary, and
 * can't tell you what changed.
 *
 * `buildPayrollLineItems` produces that frozen detail at finalize time.
 * `diffPayrollSnapshot` compares a stored snapshot against what the same
 * week would compute today, so the UI can say "current values differ
 * from what was finalized" with a real delta instead of silently
 * reconciling (or silently diverging, which is what it used to do).
 *
 * Nothing here reads the network or the store — pure functions over data
 * the caller already has, so the PDF generator and the payroll page get
 * identical numbers by construction.
 */

import type { PayrollLineItem } from '@fleetcal/types';
import type { CalendarEvent } from '@/lib/types';
import type { PayrollAdjustment } from '@/lib/db';
import { eventLegLabel } from '@/lib/legDisplay';

/** Round to cents. Money that reaches storage should already be exact —
 *  float summation over a dozen lines otherwise leaves 1e-13 dust that
 *  makes a snapshot fail its own equality check later. */
export function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function sumLineItems(items: readonly PayrollLineItem[]): number {
  return toCents(items.reduce((s, li) => s + (li.amount ?? 0), 0));
}

/** Non-relay loads print as "Both" (one driver ran pickup→delivery),
 *  matching the on-screen LegBadge and the existing pay stub. */
export function legLabelForEvent(
  load: CalendarEvent, allEvents?: readonly CalendarEvent[],
): string {
  const relayLabel = eventLegLabel(load, allEvents);
  if (relayLabel) return relayLabel;
  return 'Both';
}

export function buildPayrollLineItems(opts: {
  /** The driver's loads for the week, in display order. */
  loads: readonly CalendarEvent[];
  /** Manual payroll adjustments (bonuses, deductions, deferrals). */
  adjustments: readonly PayrollAdjustment[];
  /** Pay-to-driver accessorials, already matched to this driver.
   *  Carried as their own items so the stub can name them. */
  accessorials: readonly PayrollAdjustment[];
  /** Any list that may contain sibling relay legs — used only to
   *  resolve leg position for the label. */
  allEvents?: readonly CalendarEvent[];
}): PayrollLineItem[] {
  const { loads, adjustments, accessorials, allEvents } = opts;

  const loadItems: PayrollLineItem[] = loads.map(l => {
    const pos = l.legIndex;
    return {
      kind:   'load' as const,
      id:     l.id,
      amount: toCents(l.driverPay ?? 0),
      label:  l.title ?? '',
      // Pickup date AS IT STOOD at finalize. If the load is later moved
      // across a week boundary this is the only surviving record of why
      // it was paid in this week.
      date:     l.start?.split('T')[0],
      eventId:  l.id,
      ...(l.loadId  ? { loadId:  l.loadId }  : {}),
      ...(l.loadNum ? { loadNum: l.loadNum } : {}),
      legLabel: legLabelForEvent(l, allEvents),
      ...(pos != null       ? { legIndex: pos }        : {}),
      ...(l.legCount != null ? { legCount: l.legCount } : {}),
    };
  });

  const adjItems: PayrollLineItem[] = adjustments.map(a => ({
    kind:     'adjustment' as const,
    id:       a.id,
    amount:   toCents(a.amount),
    label:    a.description ?? '',
    category: a.category,
  }));

  const accItems: PayrollLineItem[] = accessorials.map(a => ({
    kind:     'accessorial' as const,
    id:       a.id,
    amount:   toCents(a.amount),
    label:    a.description ?? '',
    category: a.category,
  }));

  return [...loadItems, ...adjItems, ...accItems];
}

export interface SnapshotDrift {
  /** True when what this week would compute today differs from what was
   *  finalized — by total, by which lines exist, or by any amount. */
  differs: boolean;
  snapshotTotal: number;
  liveTotal: number;
  /** liveTotal − snapshotTotal. Positive = the driver would now be owed
   *  more than the stub they were issued. */
  delta: number;
  /** Lines that exist now but weren't part of the finalized stub. */
  added:   PayrollLineItem[];
  /** Lines that were paid but no longer exist in the live week —
   *  typically a load edited onto a different week or deleted. */
  removed: PayrollLineItem[];
  /** Same line, different amount. */
  changed: { before: PayrollLineItem; after: PayrollLineItem }[];
  /** False for records finalized before the snapshot migration: their
   *  total is still authoritative, but there is no detail to diff, so
   *  `added`/`removed`/`changed` are empty and only the totals were
   *  compared. */
  hasDetail: boolean;
}

export function diffPayrollSnapshot(
  snapshot: readonly PayrollLineItem[] | null | undefined,
  snapshotTotal: number,
  live: readonly PayrollLineItem[],
): SnapshotDrift {
  const liveTotal = sumLineItems(live);
  const delta = toCents(liveTotal - snapshotTotal);
  const base = {
    snapshotTotal, liveTotal, delta,
    added: [] as PayrollLineItem[],
    removed: [] as PayrollLineItem[],
    changed: [] as { before: PayrollLineItem; after: PayrollLineItem }[],
  };

  if (!snapshot || snapshot.length === 0) {
    // Legacy record — totals are all we can compare.
    return { ...base, differs: Math.abs(delta) >= 0.005, hasDetail: false };
  }

  const liveById = new Map(live.map(li => [li.id, li]));
  const snapById = new Map(snapshot.map(li => [li.id, li]));

  const added   = live.filter(li => !snapById.has(li.id));
  const removed = snapshot.filter(li => !liveById.has(li.id));
  const changed: { before: PayrollLineItem; after: PayrollLineItem }[] = [];
  for (const before of snapshot) {
    const after = liveById.get(before.id);
    if (after && Math.abs((after.amount ?? 0) - (before.amount ?? 0)) >= 0.005) {
      changed.push({ before, after });
    }
  }

  return {
    ...base,
    added, removed, changed,
    differs:
      Math.abs(delta) >= 0.005 ||
      added.length > 0 || removed.length > 0 || changed.length > 0,
    hasDetail: true,
  };
}

/** Snapshot items split into the three sections the stub renders. */
export function groupSnapshot(items: readonly PayrollLineItem[]): {
  loads: PayrollLineItem[];
  adjustments: PayrollLineItem[];
  accessorials: PayrollLineItem[];
} {
  return {
    loads:        items.filter(i => i.kind === 'load'),
    adjustments:  items.filter(i => i.kind === 'adjustment'),
    accessorials: items.filter(i => i.kind === 'accessorial'),
  };
}
