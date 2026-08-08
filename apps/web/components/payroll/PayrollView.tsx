'use client';

import { useMemo, useState, useEffect, useLayoutEffect, useRef, useCallback, Fragment } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useOrganization, useUser } from '@clerk/nextjs';
import { Users, ChevronDown, Loader2, AlertCircle, Check, Pencil, Plus, X, Trash2, CornerDownRight, Lock, Unlock, Download, RotateCcw, Info, Eye, History } from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import CopyChip from '@/components/ui/CopyChip';
import DriversModal from '@/components/sidebar/DriversModal';
import {
  fetchPayrollAdjustments, addPayrollAdjustment, deletePayrollAdjustment,
  fetchPayrollRecord, fetchPayrollRecordsForWeek, finalizeDriverPay, unfinalizeDriverPay,
  type PayrollAdjustment, type PayrollRecord,
} from '@/lib/db';
import { parseDate, fmtDate, fmtDateFull, fmtMoney, printPayroll } from '@/lib/payrollPdf';
import {
  buildPayrollLineItems, diffPayrollSnapshot, groupSnapshot, sumLineItems,
} from '@/lib/payrollSnapshot';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import type { LoadAuditEntry, LoadSummary, PayrollLineItem } from '@fleetcal/types';
import { legLabel } from '@fleetcal/types';
import {
  PAY_BASIS_LABEL, autoPayFor, fmtPct, legRevenueOf, payMatchesPct, payPctOf,
} from '@/lib/legPay';
import {
  PaySourceBadge, auditSubjectAsNext, buildAuditEntry, latestPaySource,
} from '@/lib/auditEntry';
import DataLoader from '@/components/DataLoader';
import AppShell from '@/components/nav/AppShell';
import type { CalendarEvent } from '@/lib/types';

// ─── Week helpers ─────────────────────────────────────────────────────────────

/** Returns the Saturday that starts the week containing `date`. */
function weekSaturdayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay(); // 0=Sun … 6=Sat
  d.setDate(d.getDate() - ((dow + 1) % 7));
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const FUTURE_WEEKS = 4; // how many weeks ahead to include

/** Build the list of week options — 4 future + current + 11 past (16 total). */
function buildWeekOptions(): { label: string; sat: Date; fri: Date }[] {
  const today = new Date();
  const thisSat = weekSaturdayOf(today);
  return Array.from({ length: FUTURE_WEEKS + 1 + 11 }, (_, i) => {
    const offset = FUTURE_WEEKS - i; // positive = future, 0 = this week, negative = past
    const sat = addDays(thisSat, offset * 7);
    const fri = addDays(sat, 6);
    const label =
      offset === 0 ? `This Week  (${fmtDate(sat)} – ${fmtDate(fri)})` :
      offset === 1 ? `Next Week  (${fmtDate(sat)} – ${fmtDate(fri)})` :
      offset >  1 ? `In ${offset} Weeks  (${fmtDate(sat)} – ${fmtDate(fri)})` :
      `${fmtDate(sat)} – ${fmtDate(fri)}`;
    return { label, sat, fri };
  });
}

// ─── Relay leg badge ─────────────────────────────────────────────────────────

function LegBadge({ role }: { role: CalendarEvent['relayRole'] }) {
  const cfg = role === 'pickup'
    ? { label: 'Pickup',   bg: '#1a73e81a', color: '#1a73e8',
        tip: <>This driver ran the <strong>pickup leg</strong> of a relay load. They picked up from the shipper and handed off to the next driver. Pay is split: this driver gets their leg&rsquo;s share of revenue and their own driverPay.</> }
    : role === 'transfer'
    ? { label: 'Transfer', bg: '#7c3aed1a', color: '#7c3aed',
        tip: <>This driver ran a <strong>transfer leg</strong> of a relay load — took the freight from one handoff to the next. Pay is split: this driver gets their leg&rsquo;s share of revenue and their own driverPay.</> }
    : role === 'delivery'
    ? { label: 'Delivery', bg: '#1e8e3e1a', color: '#1e8e3e',
        tip: <>This driver ran the <strong>delivery leg</strong> of a relay load. They took the freight from the previous driver to the consignee. Pay is split: this driver gets their leg&rsquo;s share of revenue and their own driverPay.</> }
    : { label: 'All',      bg: 'var(--gc-hover)', color: 'var(--gc-text-2)',
        tip: <>Non-relay load — one driver ran the <strong>full load from pickup to delivery</strong>. Full loadPrice and full driverPay belong to this driver.</> };
  return (
    <Tooltip content={cfg.tip}>
      <span
        className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
        style={{ background: cfg.bg, color: cfg.color, cursor: 'help' }}
      >
        {cfg.label}
      </span>
    </Tooltip>
  );
}

// ─── Inline-editable driver pay cell ─────────────────────────────────────────
//
// Carries the same affordances as the calendar modal's relay leg card,
// because this is the screen where pay actually gets decided:
//   • the amount, editable in place (Enter saves + jumps to the next);
//   • "N% of leg" / "N% of load" — both labelled, because a bare "27%"
//     with an unstated denominator is what lib/legPay exists to end;
//   • "Set to N% of leg|load", the same one-click reset the leg card has;
//   • an Auto / Manual marker for what determined the CURRENT figure.
//
// Density rule: amount on line one, every badge on ONE non-wrapping line
// under it. This is a scannable table, not a form.

function PayCell({ load, legRevenue, legCount, locked }: {
  load: CalendarEvent;
  /** THIS leg's miles-prorated share of the load price (lib/legPay).
   *  Equals the load price on a single-leg load. */
  legRevenue: number;
  /** Legs on this load — 1 for a normal load. Drives both the "of leg"
   *  vs "of load" basis and the audit entry's leg chip. */
  legCount: number;
  /** The week is finalized. The live view stays editable (that is the
   *  existing escape hatch, and the stub is what a finalized card shows
   *  by default), but a one-click money-mover is not something to add
   *  to a frozen week — the Set button hides. */
  locked?: boolean;
}) {
  const updateEvent  = useCalendarStore(s => s.updateEvent);
  const driverPayPct = useCalendarStore(s => s.driverPayPct);
  const { user } = useUser();
  const byName = user?.fullName?.trim() || user?.firstName?.trim() || 'Unknown';
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isRelay  = legCount > 1;
  const payNum   = typeof load.driverPay === 'number' ? load.driverPay : null;
  const lp       = load.loadPrice ?? 0;
  const base     = isRelay ? legRevenue : lp;
  const basis    = isRelay ? PAY_BASIS_LABEL.leg : PAY_BASIS_LABEL.load;
  const pctOfLeg  = payPctOf(payNum, base);
  const pctOfLoad = payPctOf(payNum, lp);
  const autoFor  = autoPayFor(base, driverPayPct);
  // payMatchesPct decides only whether there is anything left to RESET
  // to. It is never used to label provenance — a dispatcher can type the
  // exact percentage figure, and this cell would then claim the app
  // chose it.
  // Kept as a defined var so any later render logic can reference it,
  // but consumed only by showResetLeg below in the popover branch.
  void (!locked && autoFor != null && !payMatchesPct(payNum, base, driverPayPct));
  // What determined the number currently on screen, read from history.
  // undefined for every row whose pay predates paySource — those render
  // no marker at all rather than a guess.
  const paySource = latestPaySource(load.loadAuditLog, {
    legIndex:   isRelay ? load.legIndex : undefined,
    currentPay: payNum ?? undefined,
  });

  /** Write a pay figure AND its provenance. The audit entry was the
   *  missing half here: this editor called updateEvent and nothing
   *  else, so every override typed on the payroll page was invisible in
   *  the load's history. Appended server-side (`auditAppend`) because
   *  the list read strips audit_log — sending a full array would have
   *  replaced the load's history with one entry. */
  async function applyPay(value: number, source: 'auto' | 'manual') {
    setSaving(true);
    try {
      const entry = buildAuditEntry(
        load,
        { ...auditSubjectAsNext(load), newDriverPay: value, paySource: source },
        {},
        byName,
      );
      updateEvent(load.id, { driverPay: value });
      if (entry && load.loadId) {
        const chipped: LoadAuditEntry = isRelay
          ? {
              ...entry,
              leg: {
                index: load.legIndex ?? 0,
                count: legCount,
                label: legLabel(load.legIndex ?? 0, legCount) || `Leg ${(load.legIndex ?? 0) + 1}`,
                driverName: load.driverName || undefined,
              },
            }
          : entry;
        useCalendarStore.getState().markLoadSelfWrite(load.loadId);
        await railway.updateLoad(load.loadId, { auditAppend: [chipped] });
      }
    } catch (err) {
      console.error('[payroll] pay audit append failed:', err);
    } finally {
      setSaving(false);
    }
  }
  // The wrapper span (below) carries data-pay-cell-id and stays
  // mounted across the editing↔display toggle. Earlier version put
  // the data attribute on the inner button — but the button unmounts
  // while we're editing, so when commit() ran, querySelectorAll
  // couldn't find this cell and findIndex returned -1 → "next" was
  // resolved to cells[0] (the very first cell on the page). Anchoring
  // the marker on a stable wrapper fixes that.
  const cellRef = useRef<HTMLSpanElement>(null);

  function startEdit() {
    setRaw(String(load.driverPay ?? ''));
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function commit({ advance }: { advance?: boolean } = {}) {
    const val = parseFloat(raw);
    if (!isNaN(val) && val !== load.driverPay) {
      // Typed by a person — 'manual', always.
      await applyPay(val, 'manual');
    }
    setEditing(false);
    if (advance) {
      // Capture our wrapper's identity NOW (before the timeout) so
      // even if React re-renders we still know which cell was "this
      // one." Then in the next tick (after editing→display swap),
      // find the next sibling cell in document order and click its
      // button to open it for edit.
      const here = cellRef.current;
      setTimeout(() => {
        if (typeof document === 'undefined' || !here) return;
        const cells = Array.from(document.querySelectorAll<HTMLSpanElement>('[data-pay-cell-id]'));
        const idx = cells.findIndex(el => el === here);
        // idx === -1 should be impossible now (here is the same node
        // that has the data attribute), but defensive guard anyway.
        if (idx < 0) return;
        const next = cells[idx + 1];
        next?.querySelector('button')?.click();
      }, 0);
    }
  }

  /** One 10px pill, same shape as the leg card's. `emphasis` marks the
   *  primary denominator so "of leg" and "of load" can be compared at a
   *  glance without being confused. */
  const chip = (p: number | null, b: string, emphasis: boolean) => p === null ? null : (
    <span key={b} className="px-1.5 py-0.5 rounded-lg font-semibold whitespace-nowrap"
      style={{
        fontSize: 10,
        background: emphasis ? '#dbeafe' : '#f1f3f4',
        color:      emphasis ? '#1d4ed8' : 'var(--gc-text-3)',
        border:     `1px solid ${emphasis ? '#bfdbfe' : 'var(--gc-border-light)'}`,
      }}
      title={`Driver pay is ${fmtPct(p)}% ${b}`}>
      {fmtPct(p)}% <span style={{ fontWeight: 500, opacity: 0.85 }}>{b}</span>
    </span>
  );

  // Everything that USED to live as chips beside the pay input now lives
  // inside the edit popover — dispatcher clicks the pay figure, popover
  // opens with the input, the two percentages + reset buttons, and the
  // source marker. Read-only view is just the number.
  // Both reset targets: 27% of THIS LEG's share vs 27% of the FULL load
  // price. Same on a single-leg load (base === loadPrice) so the popover
  // collapses to one row there.
  const autoForLoad = autoPayFor(lp, driverPayPct);
  const showResetLeg  = !locked && autoFor      != null && !payMatchesPct(payNum, base, driverPayPct);
  const showResetLoad = !locked && isRelay && autoForLoad != null && !payMatchesPct(payNum, lp,   driverPayPct);

  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <span ref={cellRef} data-pay-cell-id={load.id} className="inline-flex items-center gap-1 min-w-0">
      <button
        ref={triggerRef}
        onClick={() => { if (!editing) startEdit(); }}
        className="group flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors"
        style={{ background: editing ? 'var(--gc-hover)' : 'transparent' }}
        onMouseOver={e => { if (!editing) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseOut={e =>  { if (!editing) e.currentTarget.style.background = 'transparent'; }}
        title="Click to edit driver pay (Enter saves + jumps to next)"
      >
        {saving ? (
          <Loader2 size={12} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
        ) : (
          <span className="text-[13px] font-semibold" style={{ color: load.driverPay != null ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
            {load.driverPay != null ? fmtMoney(load.driverPay) : '—'}
          </span>
        )}
        <Pencil size={11} className="opacity-0 group-hover:opacity-60 transition-opacity shrink-0" style={{ color: 'var(--gc-text-3)' }} />
      </button>
      {editing && (
        <PayEditPopover
          anchorRef={triggerRef}
          raw={raw}
          setRaw={setRaw}
          inputRef={inputRef}
          pctOfLeg={pctOfLeg}
          pctOfLoad={pctOfLoad}
          basis={basis}
          isRelay={isRelay}
          driverPayPct={driverPayPct}
          autoForLeg={autoFor}
          autoForLoad={autoForLoad}
          showResetLeg={showResetLeg}
          showResetLoad={showResetLoad}
          paySource={paySource}
          onResetLeg={() => {
            setRaw(String(autoFor));
            void applyPay(autoFor!, 'auto');
            setEditing(false);
          }}
          onResetLoad={() => {
            setRaw(String(autoForLoad));
            void applyPay(autoForLoad!, 'auto');
            setEditing(false);
          }}
          onCommit={(advance) => commit({ advance })}
          onCancel={() => setEditing(false)}
        />
      )}
    </span>
  );
}

/** Popover anchored to the pay-cell trigger. Portalled so it can't be
 *  clipped by row/table overflow. Click-outside closes without saving
 *  (only Enter or a reset commits). */
function PayEditPopover({
  anchorRef, raw, setRaw, inputRef,
  pctOfLeg, pctOfLoad, basis, isRelay,
  driverPayPct, autoForLeg, autoForLoad, showResetLeg, showResetLoad,
  paySource, onResetLeg, onResetLoad, onCommit, onCancel,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  raw: string;
  setRaw: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  pctOfLeg:  number | null;
  pctOfLoad: number | null;
  basis: string;
  isRelay: boolean;
  driverPayPct: number | null;
  autoForLeg:  number | null;
  autoForLoad: number | null;
  showResetLeg:  boolean;
  showResetLoad: boolean;
  paySource: 'auto' | 'manual' | undefined;
  onResetLeg:  () => void;
  onResetLoad: () => void;
  onCommit: (advance: boolean) => void;
  onCancel: () => void;
}) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Position under the trigger, clamped to viewport. Recompute on
  // scroll/resize so the popover follows the cell if the table scrolls.
  useLayoutEffect(() => {
    const place = () => {
      const trigger = anchorRef.current;
      const bubble  = bubbleRef.current;
      if (!trigger || !bubble) return;
      const tr = trigger.getBoundingClientRect();
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      const gap = 4;
      // Prefer below; flip above when there isn't room.
      let top = tr.bottom + gap;
      if (top + bh > window.innerHeight - 8) top = tr.top - bh - gap;
      let left = tr.left;
      if (left + bw > window.innerWidth - 8) left = window.innerWidth - bw - 8;
      if (left < 8) left = 8;
      setCoords({ top, left });
    };
    place();
    window.addEventListener('scroll',  place, true);
    window.addEventListener('resize',  place);
    return () => {
      window.removeEventListener('scroll',  place, true);
      window.removeEventListener('resize',  place);
    };
  }, [anchorRef]);

  // Click-outside closes. Focus the input on mount for immediate typing.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const bubble = bubbleRef.current;
      const trigger = anchorRef.current;
      const target = e.target as Node;
      if (bubble?.contains(target) || trigger?.contains(target)) return;
      onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown',   onKey);
    setTimeout(() => inputRef.current?.select(), 0);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown',   onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (typeof document === 'undefined') return null;

  const money = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const pctRow = (kind: 'leg' | 'load') => {
    const pct   = kind === 'leg' ? pctOfLeg : pctOfLoad;
    const target = kind === 'leg' ? autoForLeg : autoForLoad;
    const show   = kind === 'leg' ? showResetLeg : showResetLoad;
    const label  = kind === 'leg' ? basis : PAY_BASIS_LABEL.load;
    return (
      <div className="flex items-center justify-between gap-3 py-1.5">
        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
          <span className="tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {pct !== null ? `${fmtPct(pct)}%` : '—'}
          </span>
          <span style={{ color: 'var(--gc-text-3)' }}>{label}</span>
        </div>
        {show && driverPayPct != null && target != null && (
          <button type="button"
            onClick={kind === 'leg' ? onResetLeg : onResetLoad}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold transition-colors"
            style={{ background: 'transparent', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#dbeafe'; e.currentTarget.style.color = '#1d4ed8'; e.currentTarget.style.borderColor = '#bfdbfe'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-2)'; e.currentTarget.style.borderColor = 'var(--gc-border)'; }}
            title={`Set pay to ${driverPayPct}% of ${label} (${money(target)})`}>
            <RotateCcw size={10} />
            Reset to {driverPayPct}% {label}
          </button>
        )}
      </div>
    );
  };

  return createPortal(
    <div
      ref={bubbleRef}
      role="dialog"
      onMouseDown={e => e.stopPropagation()}
      style={{
        position:  'fixed',
        top:       coords?.top ?? -9999,
        left:      coords?.left ?? -9999,
        zIndex:    1000,
        minWidth:  280,
        background: 'var(--gc-surface)',
        border:    '1px solid var(--gc-border)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        padding:   12,
        visibility: coords ? 'visible' : 'hidden',
      }}>
      {/* Input */}
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: 'var(--gc-text-3)' }} className="text-sm">$</span>
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          value={raw}
          onChange={e => setRaw(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); onCommit(true); }
            // Escape handled by the doc listener above.
          }}
          className="flex-1 px-2 py-1 rounded text-sm font-semibold text-right"
          style={{
            background: 'var(--gc-bg)',
            border: '1px solid var(--gc-blue)',
            color: 'var(--gc-text-1)',
            outline: 'none',
          }}
        />
      </div>

      {/* Percentages + reset buttons */}
      <div style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {pctRow('leg')}
        {/* Only relays get the second row — for a single-leg load the
            two denominators are the same number and the two rows would
            just duplicate. */}
        {isRelay && pctRow('load')}
      </div>

      {/* Source marker + save hint */}
      <div className="flex items-center justify-between pt-2 mt-1 text-[11px]"
        style={{ borderTop: '1px solid var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
        <div>
          Source: <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>
            {paySource === 'auto' ? 'Auto' : paySource === 'manual' ? 'Manual' : '—'}
          </span>
        </div>
        <div style={{ opacity: 0.7 }}>Enter to save · Esc to cancel</div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Accessorial category display labels ─────────────────────────────────────

const ACC_CAT_LABELS: Record<string, string> = {
  detention:    'Detention',
  lumper:       'Lumper',
  layover:      'Layover',
  scale_ticket: 'Scale Ticket',
  extra_stop:   'Extra Stop',
  other:        'Other',
};

// ─── Adjustment categories ────────────────────────────────────────────────────

const ADJ_CATEGORIES = [
  'Bonus', 'Deduction', 'Fuel Advance', 'Layover', 'Detention', 'Reimbursement', 'Other',
] as const;

const INPUT_STYLE: React.CSSProperties = {
  height: 34, border: '1px solid var(--gc-border)', background: 'var(--gc-bg)',
  color: 'var(--gc-text-1)', outline: 'none', borderRadius: 8, padding: '0 8px', fontSize: 14,
};

// ─── Adjustments section ─────────────────────────────────────────────────────

function AdjustmentsSection({
  orgId, driverName, driverAliases, weekStart, sat, onListChange, refreshTick,
}: {
  orgId: string;
  /** Canonical display name — used when writing new adjustments
   *  so future saves go under one consistent name. */
  driverName: string;
  /** Every historical name the driver has been known by. Includes
   *  `driverName`. Used to PULL existing adjustments that were saved
   *  under any of those names, so a renamed driver still sees their
   *  old deferred-pay / per-diem / etc. lines. */
  driverAliases: string[];
  weekStart: string;
  sat: Date;
  /** The parent derives every total from this list — there is no separate
   *  total callback, so the number on the card and the lines behind it
   *  can never disagree. */
  onListChange: (list: PayrollAdjustment[]) => void;
  refreshTick?: number;
}) {
  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([]);
  const [mode,     setMode]     = useState<'idle' | 'add' | 'defer'>('idle');
  const [saving,   setSaving]   = useState(false);
  const [category, setCategory] = useState<string>(ADJ_CATEGORIES[0]);
  const [desc,     setDesc]     = useState('');
  const [amount,   setAmount]   = useState('');
  // Defer-specific — compute next 4 weeks forward from sat (independent of weekOptions)
  const futureWeeks = useMemo(() => Array.from({ length: 4 }, (_, i) => {
    const s = addDays(sat, (i + 1) * 7);
    const f = addDays(s, 6);
    return { sat: s, fri: f };
  }), [sat]);
  const [deferToIdx,      setDeferToIdx]      = useState(0);
  const [deferAmt,        setDeferAmt]        = useState('');
  const [adjDeferConfirm, setAdjDeferConfirm] = useState(false);
  const [undoingId,       setUndoingId]       = useState<string | null>(null);

  function sync(list: PayrollAdjustment[]) {
    setAdjustments(list);
    onListChange(list);
  }

  // Match adjustments against any alias the driver has been known
  // by (case-insensitive). Without this, a rename — which leaves
  // old adjustments tagged to the old name in the DB — would orphan
  // them under a duplicate row.
  const aliasMatch = useMemo(() => {
    const set = new Set(driverAliases.map(a => a.trim().toLowerCase()).filter(Boolean));
    return (n?: string) => !!n && set.has(n.trim().toLowerCase());
  }, [driverAliases]);

  useEffect(() => {
    if (!orgId || !weekStart) return;
    fetchPayrollAdjustments(orgId, weekStart).then(all => sync(all.filter(a => aliasMatch(a.driverName))));
  }, [orgId, driverName, weekStart, refreshTick, aliasMatch]); // eslint-disable-line

  function openAdd() { setCategory(ADJ_CATEGORIES[0]); setDesc(''); setAmount(''); setMode('add'); }
  function openDefer() { setDeferToIdx(0); setDeferAmt(''); setMode('defer'); }

  async function handleSaveAdj() {
    const val = parseFloat(amount);
    if (isNaN(val) || !category) return;
    setSaving(true);
    const saved = await addPayrollAdjustment({ orgId, driverName, weekStart, category, description: desc.trim() || undefined, amount: val });
    if (saved) sync([...adjustments, saved]);
    setSaving(false); setMode('idle');
  }

  async function handleDefer() {
    const val = parseFloat(deferAmt);
    if (isNaN(val) || val <= 0 || futureWeeks.length === 0) return;
    const target = futureWeeks[deferToIdx];
    const targetWeekStart = target.sat.toISOString().split('T')[0];
    const targetLabel = fmtDate(target.sat);
    const fromLabel   = fmtDate(sat);
    setSaving(true);
    // Negative in current week
    const neg = await addPayrollAdjustment({ orgId, driverName, weekStart, category: 'Deferred', description: `Deferred to ${targetLabel}`, amount: -val });
    // Positive in target week
    await addPayrollAdjustment({ orgId, driverName, weekStart: targetWeekStart, category: 'Deferred', description: `Deferred from ${fromLabel}`, amount: val });
    if (neg) sync([...adjustments, neg]);
    setSaving(false); setMode('idle'); setAdjDeferConfirm(false);
  }

  async function handleDelete(id: string) {
    await deletePayrollAdjustment(id);
    sync(adjustments.filter(a => a.id !== id));
  }

  // Undo a deferred payment: delete the positive adj here AND hunt for the paired negative in past weeks
  async function handleUndoDefer(adj: PayrollAdjustment) {
    setUndoingId(adj.id);
    // Search up to 6 weeks back for the matching negative (same driver, category, negated amount)
    for (let i = 1; i <= 6; i++) {
      const srcSat = addDays(sat, -i * 7);
      const srcWeekStart = srcSat.toISOString().split('T')[0];
      const srcAdjs = await fetchPayrollAdjustments(orgId, srcWeekStart);
      const neg = srcAdjs.find(a =>
        a.driverName === driverName &&
        a.category === 'Deferred' &&
        Math.abs(a.amount) === adj.amount
      );
      if (neg) { await deletePayrollAdjustment(neg.id); break; }
    }
    await deletePayrollAdjustment(adj.id);
    sync(adjustments.filter(a => a.id !== adj.id));
    setUndoingId(null);
  }

  return (
    <div style={{ borderTop: '1px solid var(--gc-border-light)', padding: '12px 20px 16px' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Adjustments</span>
        {mode === 'idle' && (
          <div className="flex items-center gap-1">
            <Tooltip
              content={
                <>
                  Add a manual line to this week&rsquo;s pay — bonus, deduction, reimbursement, per-diem, fuel advance, etc. Adds to <strong>Driver Pay</strong> immediately; persists across reloads.
                </>
              }>
              <button onClick={openAdd}
                className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                style={{ color: 'var(--gc-blue)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={12} /> Add
              </button>
            </Tooltip>
            {futureWeeks.length > 0 && (
              <Tooltip
                content={
                  <>
                    Push a dollar amount out of this week&rsquo;s pay into a future week. Writes a matched pair of adjustments: <strong>negative</strong> here, <strong>positive</strong> in the target week. Use for over-the-road runs that span the Sat–Fri cutoff.
                  </>
                }>
                <button onClick={openDefer}
                  className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-colors"
                  style={{ color: 'var(--gc-text-2)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <CornerDownRight size={12} /> Defer
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Existing adjustments — deferred items shown as grouped summary */}
      {adjustments.length > 0 && (() => {
        const regularAdjs  = adjustments.filter(a => !(a.category === 'Deferred' && a.amount < 0));
        const deferredAdjs = adjustments.filter(a => a.category === 'Deferred' && a.amount < 0);
        // Group deferred by target week label (parsed from "… Deferred to May 3")
        const deferGroups = new Map<string, { adjs: typeof deferredAdjs; total: number }>();
        for (const adj of deferredAdjs) {
          const m = adj.description?.match(/Deferred to (.+)$/);
          const key = m ? m[1] : 'following week';
          const g = deferGroups.get(key) ?? { adjs: [], total: 0 };
          deferGroups.set(key, { adjs: [...g.adjs, adj], total: g.total + adj.amount });
        }
        return (
          <div className="mb-3 space-y-1.5">
            {regularAdjs.map(adj => {
              const isDeferred    = adj.category === 'Deferred';
              const isDeferredIn  = isDeferred && adj.amount > 0; // positive = carry-in from another week
              const isUndoing     = undoingId === adj.id;
              // Strip embedded [loadId] prefix from description if present
              const displayDesc = adj.description?.replace(/^\[[a-f0-9-]+\]\s*/, '') ?? undefined;
              return (
                <div key={adj.id} className="flex items-center gap-3 text-sm group">
                  <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                    style={{
                      background: isDeferred ? '#6941c61a' : adj.amount >= 0 ? '#1e8e3e1a' : '#d9302514',
                      color: isDeferred ? '#6941c6' : adj.amount >= 0 ? '#1e8e3e' : '#d93025',
                    }}>
                    {adj.category}
                  </span>
                  <span className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                    {displayDesc ?? <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                  </span>
                  <span className="font-semibold whitespace-nowrap" style={{ color: isDeferred ? '#6941c6' : adj.amount >= 0 ? '#1e8e3e' : '#d93025' }}>
                    {adj.amount >= 0 ? '+' : ''}{fmtMoney(adj.amount)}
                  </span>
                  {isDeferredIn ? (
                    <button
                      onClick={() => handleUndoDefer(adj)}
                      disabled={isUndoing}
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-lg"
                      style={{ color: '#6941c6', background: '#6941c61a', flexShrink: 0, whiteSpace: 'nowrap' }}
                      title="Undo this deferral (removes pay from this week and restores it to the source week)"
                    >
                      {isUndoing ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                      Undo
                    </button>
                  ) : (
                    <button onClick={() => handleDelete(adj.id)}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded"
                      style={{ color: 'var(--gc-text-3)' }} title="Remove">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })}
            {[...deferGroups.entries()].map(([targetLabel, { adjs, total }]) => (
              <div key={targetLabel} className="flex items-center gap-3 text-sm">
                <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                  style={{ background: '#6941c61a', color: '#6941c6' }}>
                  Deferred
                </span>
                <span className="flex-1" style={{ color: 'var(--gc-text-2)' }}>
                  {adjs.length} load{adjs.length !== 1 ? 's' : ''} deferred to {targetLabel}
                </span>
                <span className="font-semibold whitespace-nowrap" style={{ color: '#6941c6' }}>
                  {fmtMoney(total)}
                </span>
              </div>
            ))}
          </div>
        );
      })()}
      {adjustments.length === 0 && mode === 'idle' && (
        <p className="text-xs" style={{ color: 'var(--gc-text-3)' }}>No adjustments this week.</p>
      )}

      {/* Add adjustment form */}
      {mode === 'add' && (
        <div className="flex items-end gap-2 mt-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Category</label>
            <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...INPUT_STYLE, width: 150 }}>
              {ADJ_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1" style={{ minWidth: 140 }}>
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Description</label>
            <input type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional note…" style={INPUT_STYLE} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Amount</label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="−50.00" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSaveAdj(); if (e.key === 'Escape') setMode('idle'); }}
              style={{ ...INPUT_STYLE, width: 110, textAlign: 'right', borderColor: 'var(--gc-blue)' }} />
          </div>
          <button onClick={handleSaveAdj} disabled={saving || !amount}
            className="flex items-center gap-1 text-sm font-semibold px-3 rounded-lg transition-colors"
            style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: saving || !amount ? 0.6 : 1 }}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
          </button>
          <button onClick={() => setMode('idle')} style={{ height: 34, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={15} />
          </button>
        </div>
      )}

      {/* Defer payment form */}
      {mode === 'defer' && !adjDeferConfirm && (
        <div className="flex items-end gap-2 mt-2 flex-wrap">
          <div className="flex flex-col gap-1 flex-1" style={{ minWidth: 180 }}>
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Defer to Week</label>
            <select value={deferToIdx} onChange={e => setDeferToIdx(+e.target.value)} style={{ ...INPUT_STYLE, width: '100%' }}>
              {futureWeeks.map((w, i) => (
                <option key={i} value={i}>{fmtDate(w.sat)} – {fmtDate(w.fri)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>Amount</label>
            <input type="number" step="0.01" value={deferAmt} onChange={e => setDeferAmt(e.target.value)} placeholder="0.00" autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && deferAmt) setAdjDeferConfirm(true); if (e.key === 'Escape') setMode('idle'); }}
              style={{ ...INPUT_STYLE, width: 110, textAlign: 'right', borderColor: 'var(--gc-blue)' }} />
          </div>
          <button onClick={() => { if (deferAmt) setAdjDeferConfirm(true); }} disabled={!deferAmt}
            className="flex items-center gap-1 text-sm font-semibold px-3 rounded-lg"
            style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: !deferAmt ? 0.6 : 1, cursor: 'pointer' }}>
            <CornerDownRight size={13} /> Defer
          </button>
          <button onClick={() => setMode('idle')} style={{ height: 34, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={15} />
          </button>
        </div>
      )}
      {/* Defer confirmation */}
      {mode === 'defer' && adjDeferConfirm && (
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <span className="text-sm flex-1" style={{ color: 'var(--gc-text-2)' }}>
            Defer <strong>{fmtMoney(parseFloat(deferAmt))}</strong> to week of <strong>{fmtDate(futureWeeks[deferToIdx].sat)}</strong>?
          </span>
          <button onClick={handleDefer} disabled={saving}
            className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
            style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: saving ? 0.7 : 1, cursor: 'pointer' }}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Confirm
          </button>
          <button onClick={() => setAdjDeferConfirm(false)}
            className="text-sm px-3 rounded-lg transition-colors"
            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', height: 34, cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Frozen stub (finalized week) ────────────────────────────────────────────
//
// Renders a finalized week FROM ITS SNAPSHOT. Same columns as the live
// table minus the two dispatcher-only metrics (Miles, Load Value) —
// those are properties of the load today, not of the payment that was
// made, and the snapshot deliberately doesn't freeze them. Everything
// here is read-only: this is the document that was issued.
//
// Titles stay clickable when the source load still exists, so a finalized
// week never traps you — you can open and edit the load, and the card
// then tells you the numbers have diverged.

function FrozenStubTable({ groups, liveLoadIds, onOpenLoad }: {
  groups: { loads: PayrollLineItem[]; adjustments: PayrollLineItem[]; accessorials: PayrollLineItem[] };
  liveLoadIds: Set<string>;
  onOpenLoad: (eventId: string) => void;
}) {
  const section = (title: string, items: PayrollLineItem[], tint: string, color: string) =>
    items.length > 0 && (
      <div style={{ borderTop: '1px solid var(--gc-border-light)', padding: '12px 20px 14px' }}>
        <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--gc-text-3)' }}>
          {title}
        </div>
        <div className="space-y-1.5">
          {items.map(li => (
            <div key={li.id} className="flex items-center gap-3 text-sm">
              <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                style={{ background: tint, color }}>
                {li.category ?? '—'}
              </span>
              <span className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                {li.label || <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
              </span>
              <span className="font-semibold whitespace-nowrap"
                style={{ color: li.amount >= 0 ? '#1e8e3e' : '#d93025' }}>
                {li.amount >= 0 ? '+' : ''}{fmtMoney(li.amount)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              {['Date', 'Leg', 'Event Title', 'Load #', 'Driver Pay'].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.loads.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-3 text-sm" style={{ color: 'var(--gc-text-3)' }}>
                No loads on this pay record — the total came from adjustments only.
              </td></tr>
            )}
            {groups.loads.map(li => {
              const stillLive = !!li.eventId && liveLoadIds.has(li.eventId);
              return (
                <tr key={li.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
                    {li.date
                      ? parseDate(li.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                      style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-2)' }}>
                      {li.legLabel ?? 'All'}
                    </span>
                  </td>
                  <td className="px-4 py-3 max-w-[280px]">
                    {stillLive ? (
                      <button onClick={() => onOpenLoad(li.eventId!)}
                        className="inline-flex max-w-full text-left font-medium hover:underline truncate"
                        style={{ color: 'var(--gc-blue)' }} title={li.label}>
                        {li.label || '(no title)'}
                      </button>
                    ) : (
                      <Tooltip content={<>This load is no longer part of the live week — it was edited, moved to another week, or deleted after the pay record was issued. The line stays on the stub because it was paid.</>}>
                        <span className="truncate inline-block max-w-full" style={{ color: 'var(--gc-text-2)', cursor: 'help', borderBottom: '1px dotted var(--gc-text-3)' }}>
                          {li.label || '(no title)'}
                        </span>
                      </Tooltip>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {li.loadNum
                      ? <CopyChip value={li.loadNum} style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-2)' }} />
                      : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                  </td>
                  <td className="px-4 py-3 font-semibold whitespace-nowrap" style={{ color: 'var(--gc-text-1)' }}>
                    {fmtMoney(li.amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {section('Accessorials (as paid)', groups.accessorials, '#1a73e81a', '#1a73e8')}
      {section('Adjustments (as paid)', groups.adjustments, 'var(--gc-hover)', 'var(--gc-text-2)')}
    </>
  );
}

// ─── Driver payroll card ──────────────────────────────────────────────────────

interface DriverRow {
  /** Canonical display name — current name from the driver record
   *  if we matched by id, else the stored driverName from the load. */
  driverName: string;
  /** Every historical name string we've seen this driver under,
   *  including the canonical one. Used to fold in adjustments /
   *  records that were saved before a rename. */
  aliases: string[];
  /** Driver record id when this row is anchored to one. Loads that
   *  carry only a legacy `driverName` (no driverId) stand alone. */
  driverId?: number;
  loads: CalendarEvent[];
}

function DriverCard({ row, assets, drivers, orgId, weekStart, orgName, orgLogoUrl, weekLabel, sat, fri }: {
  row: DriverRow;
  assets: ReturnType<typeof useCalendarStore.getState>['assets'];
  drivers: ReturnType<typeof useCalendarStore.getState>['drivers'];
  orgId: string;
  weekStart: string;
  orgName: string;
  orgLogoUrl?: string;
  weekLabel: string;
  sat: Date;
  fri: Date;
}) {
  const openEditModal = useCalendarStore(s => s.openEditModal);
  const updateEvent   = useCalendarStore(s => s.updateEvent);
  const allEvents     = useCalendarStore(s => s.events);
  const { user }      = useUser();
  const [adjList,       setAdjList]       = useState<PayrollAdjustment[]>([]);
  const [record,        setRecord]        = useState<PayrollRecord | null>(null);
  const [finalizing,    setFinalizing]    = useState(false);
  const [confirmFin,    setConfirmFin]    = useState(false);
  // Finalized cards render the FROZEN snapshot by default. This flips to
  // the live, editable view — the escape hatch that keeps a finalized
  // week from trapping anyone. Editing a load is never blocked; the card
  // just tells you the stub and the current numbers have parted ways.
  const [showLive,      setShowLive]      = useState(false);
  const [reopening,     setReopening]     = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const [sending,       setSending]       = useState(false);
  /** null = idle, string = last outcome text to flash for a few seconds
   *  under the button (green when everything sent, amber when partial,
   *  red when nothing landed). */
  const [sendFlash,     setSendFlash]     = useState<{ tone: 'ok' | 'warn' | 'err'; msg: string } | null>(null);
  const [showProfile,   setShowProfile]   = useState(false);
  const [printing,      setPrinting]      = useState(false);
  const [trashConfirm,  setTrashConfirm]  = useState<string | null>(null); // adj.id pending confirm
  // Per-load defer state
  const [deferLoadId,    setDeferLoadId]    = useState<string | null>(null);
  const [deferToWeekIdx, setDeferToWeekIdx] = useState(0);
  const [deferring,      setDeferring]      = useState(false);
  const [deferConfirm,   setDeferConfirm]   = useState(false);
  const [undoDeferLoadId, setUndoDeferLoadId] = useState<string | null>(null); // undo confirm

  // Accessorials marked "Pay Driver" on this driver's loads
  const payToDriverAccs = useMemo<PayrollAdjustment[]>(() => {
    const items: PayrollAdjustment[] = [];
    for (const load of row.loads) {
      for (const acc of (load.accessorials ?? [])) {
        if (!acc.payToDriver) continue;
        const target = acc.payDriverName?.trim() || load.driverName || '';
        if (target.toLowerCase() !== row.driverName.toLowerCase()) continue;
        items.push({
          id: `acc-${load.id}-${acc.id}`,
          driverName: row.driverName,
          weekStart,
          category: ACC_CAT_LABELS[acc.category] ?? acc.category,
          description: acc.description || load.title || '',
          amount: acc.amount,
          createdAt: '',
        });
      }
    }
    return items;
  }, [row.loads, row.driverName, orgId, weekStart]);

  // Next 4 weeks forward from current sat (for per-load defer target)
  const deferWeeks = useMemo(() => Array.from({ length: 4 }, (_, i) => {
    const s = addDays(sat, (i + 1) * 7);
    const f = addDays(s, 6);
    return { sat: s, fri: f };
  }), [sat]);

  // Non-final relay legs (pickup or transfer) whose FINAL delivery leg
  // falls after fri (spanning weekend).
  const spanningRelayLoadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const load of row.loads) {
      if (!load.relayGroupId || !load.relayRole || load.relayRole === 'delivery') continue;
      const finalLeg = allEvents.find(e =>
        e.relayGroupId === load.relayGroupId &&
        e.relayRole === 'delivery' &&
        e.id !== load.id
      );
      if (finalLeg && parseDate(finalLeg.start) > fri) ids.add(load.id);
    }
    return ids;
  }, [row.loads, allEvents, fri]);

  const driverRecord = drivers.find(d =>
    d.name?.toLowerCase() === row.driverName.toLowerCase() ||
    `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim().toLowerCase() === row.driverName.toLowerCase()
  );

  // Revenue per LEG for relay loads — pro-rated by routed leg miles
  // so a 500-mile pickup paired with a 200-mile delivery on a
  // $1,400 load credits the pickup driver $1,000 and the delivery
  // driver $400. When any leg is missing loadedMiles, fall back
  // to an even 1/N split across the legs. Non-relay loads return
  // their stored loadPrice unchanged.
  //
  // The authoritative load price is the MAX across legs — handles
  // both the common case (loadPrice duplicated on every leg) and
  // the case where it was set on only one leg.
  // Delegates to lib/legPay — the rule described above lives there now.
  // This function used to reimplement it inline, which is exactly how
  // the payroll page and the calendar modal drifted to two different
  // denominators for the same leg. Semantics are unchanged: max price
  // across legs, miles-prorated, even 1/N whenever any leg's miles are
  // unknown, whole price for a single-leg load.
  const legRevenue = useCallback((l: CalendarEvent): number => {
    if (!l.relayGroupId) return l.loadPrice ?? 0;
    const legs = allEvents.filter(e => e.relayGroupId === l.relayGroupId);
    return legRevenueOf(l, legs.length > 1 ? legs : [l]);
  }, [allEvents]);

  const totalRev = row.loads.reduce((s, l) => s + legRevenue(l), 0);
  const isFinalized = record !== null;

  // ── Snapshot vs live ────────────────────────────────────────────────
  //
  // `liveLineItems` is what this week computes RIGHT NOW. It is what a
  // Finalize would freeze, and what a finalized week gets diffed
  // against. It is NOT what a finalized card displays.
  const liveLineItems = useMemo(() => buildPayrollLineItems({
    loads: row.loads,
    adjustments: adjList,
    accessorials: payToDriverAccs,
    allEvents,
  }), [row.loads, adjList, payToDriverAccs, allEvents]);
  const liveTotal = useMemo(() => sumLineItems(liveLineItems), [liveLineItems]);
  // Which snapshot lines still correspond to a load in the live store —
  // decides whether a frozen row's title is clickable.
  const liveLoadIdSet = useMemo(
    () => new Set(allEvents.map(e => e.id)),
    [allEvents],
  );

  // The frozen detail, when this record has any. Records finalized
  // before the 20260728 migration (and the historical backfill rows)
  // carry only a total — for those, `record.totalPay` is still the
  // number we display, we just can't render frozen rows.
  const snapshot = record?.lineItems?.length ? record.lineItems : null;
  const snapshotGroups = useMemo(
    () => (snapshot ? groupSnapshot(snapshot) : null),
    [snapshot],
  );

  const drift = useMemo(
    () => (record ? diffPayrollSnapshot(snapshot, record.totalPay, liveLineItems) : null),
    [record, snapshot, liveLineItems],
  );

  // THE fix: once a week is finalized, the recorded total is the number
  // this card shows — everywhere on it. Previously the header re-summed
  // live values while the footer printed the record, so one card could
  // display two different totals five lines apart.
  const displayTotal = isFinalized ? record!.totalPay : liveTotal;
  // `totalPay` keeps its old meaning for the finalize action: the amount
  // that WOULD be recorded if you finalized right now.
  const totalPay = liveTotal;
  /** Rendering the issued stub rather than a live recompute. */
  const frozenView = isFinalized && !!snapshot && !showLive;

  // Remove a payToDriver accessorial by setting payToDriver: false on the source event
  async function removeAccAdj(adjId: string) {
    // id format: "acc-{loadId}-{accId}"
    const parts = adjId.split('-');
    // loadId is a UUID (contains dashes), accId is the last UUID segment group
    // Format: "acc" + "-" + <loadId (uuid with dashes)> + "-" + <accId (uuid with dashes)>
    // Safer: strip leading "acc-" then split on the known accId
    const withoutPrefix = adjId.replace(/^acc-/, '');
    // Find which load this belongs to
    const load = row.loads.find(l => withoutPrefix.startsWith(l.id + '-'));
    if (!load) return;
    const accId = withoutPrefix.slice(load.id.length + 1); // everything after "{loadId}-"
    const updated = (load.accessorials ?? []).map(a =>
      a.id === accId ? { ...a, payToDriver: false, payDriverName: undefined } : a
    );
    await updateEvent(load.id, { accessorials: updated });
    setTrashConfirm(null);
  }

  function openDeferForLoad(load: CalendarEvent) {
    setDeferLoadId(load.id);
    setDeferToWeekIdx(0);
    setDeferConfirm(false);
  }

  async function handleDeferLoad(load: CalendarEvent) {
    if (deferWeeks.length === 0) return;
    const targetWeekStart = deferWeeks[deferToWeekIdx].sat.toISOString().split('T')[0];
    setDeferring(true);
    await updateEvent(load.id, { deferredToWeek: targetWeekStart });
    setDeferring(false);
    setDeferLoadId(null);
    setDeferConfirm(false);
  }

  async function handleUndoDeferLoad(load: CalendarEvent) {
    setDeferring(true);
    // null (not undefined) — undefined gets stripped by JSON.stringify so
    // the body would arrive as {} and the API would 400 "no allowed
    // fields supplied". null serializes through and the handler maps it
    // to SQL NULL via `body.deferredToWeek ?? null`.
    await updateEvent(load.id, { deferredToWeek: null });
    setDeferring(false);
    setUndoDeferLoadId(null);
  }

  async function handleDriverPrint() {
    if (printing) return;
    setPrinting(true);
    try {
      printPayroll({
        orgName,
        orgLogoUrl,
        weekLabel,
        sat,
        fri,
        // `record` carries the frozen line items when the week is
        // finalized — printPayroll renders THOSE and ignores the live
        // loads/adjustments, so a reprint reproduces the issued stub.
        drivers: [{
          driverName: row.driverName,
          loads: row.loads,
          adjustments: [...adjList, ...payToDriverAccs],
          record,
          allEvents,
        }],
      });
    } finally {
      setPrinting(false);
    }
  }

  useEffect(() => {
    if (!orgId || !weekStart) return;
    // Try the canonical name first, then any historical alias. A
    // finalized record from before a driver rename is stored under
    // the old name in the DB — without this fallback it would
    // disappear from the queue and the driver could be finalized
    // twice for the same week.
    let cancelled = false;
    (async () => {
      const tried = new Set<string>();
      for (const name of [row.driverName, ...row.aliases]) {
        const key = name.trim();
        if (!key || tried.has(key.toLowerCase())) continue;
        tried.add(key.toLowerCase());
        const found = await fetchPayrollRecord(orgId, key, weekStart);
        if (cancelled) return;
        if (found) { setRecord(found); return; }
      }
      if (!cancelled) setRecord(null);
    })();
    return () => { cancelled = true; };
  }, [orgId, row.driverName, row.aliases, weekStart]);

  const actorName =
    user?.fullName?.trim() ||
    user?.primaryEmailAddress?.emailAddress ||
    null;

  /** Freeze the week: the total AND every line behind it. Used both for
   *  the first Finalize and for Re-finalize after a correction — the
   *  server supersedes the previous record rather than overwriting it,
   *  so the earlier amount survives. */
  async function snapshotWeek() {
    setFinalizing(true);
    const rec = await finalizeDriverPay(
      orgId, row.driverName, weekStart,
      sumLineItems(liveLineItems), liveLineItems, actorName,
    );
    if (rec) { setRecord(rec); setShowLive(false); }
    setFinalizing(false); setConfirmFin(false);
  }

  async function handleReopen() {
    if (!record) return;
    setReopening(true);
    // Soft — the API supersedes the record and keeps it, along with who
    // reopened it and when. Nothing about the payment is destroyed.
    await unfinalizeDriverPay(record.id, actorName);
    setRecord(null);
    setShowLive(false);
    setReopening(false);
    setConfirmReopen(false);
  }

  async function handleSend() {
    if (!record) return;
    setSending(true);
    setSendFlash(null);
    try {
      const res = await railway.sendPaystub(record.id);
      // Merge the returned record so the header + footer picks up
      // sent_at / sent_via without a full page refetch.
      setRecord(res.record);
      const okChannels: string[] = [];
      if (res.smsResult.ok)  okChannels.push('SMS');
      if (res.pushResult.ok) okChannels.push('push');
      if (okChannels.length === 2) {
        setSendFlash({ tone: 'ok', msg: 'Sent by SMS + push.' });
      } else if (okChannels.length === 1) {
        // Partial — surface the failed channel so dispatch knows why
        // (bad phone, no device, Twilio config missing, etc.).
        const failed = res.smsResult.ok
          ? `push failed: ${(res.pushResult as { error: string }).error}`
          : `SMS failed: ${(res.smsResult as { error: string }).error}`;
        setSendFlash({ tone: 'warn', msg: `Sent by ${okChannels[0]}. ${failed}` });
      } else {
        setSendFlash({
          tone: 'err',
          msg: `Nothing sent. SMS: ${(res.smsResult as { error: string }).error}. Push: ${(res.pushResult as { error: string }).error}.`,
        });
      }
    } catch (err) {
      setSendFlash({ tone: 'err', msg: err instanceof Error ? err.message : 'Send failed.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{
      background: 'var(--gc-surface)',
      border: isFinalized ? '1px solid #1e8e3e44' : '1px solid var(--gc-border)',
      borderRadius: 12, overflow: 'hidden',
    }}>
      {/* Driver header */}
      <div className="flex items-center justify-between px-5 py-3.5"
        style={{ borderBottom: '1px solid var(--gc-border-light)', background: isFinalized ? '#1e8e3e08' : undefined }}>
        <button
          onClick={() => setShowProfile(true)}
          className="flex items-center gap-3 rounded-lg px-2 py-1 -ml-2 transition-colors"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="View driver profile"
        >
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
            style={{ background: '#1a73e81a', color: 'var(--gc-blue)' }}>
            {row.driverName.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[15px]" style={{ color: 'var(--gc-blue)', textDecoration: 'underline', textUnderlineOffset: 2, textDecorationColor: 'rgba(26,115,232,0.35)' }}>{row.driverName}</span>
              {isFinalized && (
                <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-lg"
                  style={{ background: '#1e8e3e1a', color: '#1e8e3e' }}>
                  <Lock size={10} /> Paid
                </span>
              )}
            </div>
            <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
              {/* Finalized cards count the loads ON THE STUB, not the
                  loads the week happens to compute today. */}
              {(frozenView ? snapshotGroups!.loads.length : row.loads.length)} load
              {(frozenView ? snapshotGroups!.loads.length : row.loads.length) !== 1 ? 's' : ''}
              {isFinalized && ` · Finalized ${new Date(record!.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
              {isFinalized && record!.finalizedByName ? ` by ${record!.finalizedByName}` : ''}
            </div>
          </div>
        </button>

        {showProfile && (
          <DriversModal
            onClose={() => setShowProfile(false)}
            initialDriverId={driverRecord?.id}
          />
        )}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5 inline-flex items-center gap-1" style={{ color: 'var(--gc-text-3)' }}>
              {isFinalized ? 'Driver Pay · Finalized' : 'Driver Pay'}
              <Tooltip
                placement="bottom"
                content={
                  isFinalized ? (
                    <>
                      The amount <strong>recorded when this week was finalized</strong>. It does not move when loads or adjustments change afterwards — that is the point of finalizing. If current values have diverged, the banner below says by how much.
                    </>
                  ) : (
                    <>
                      Per-load <strong>driver pay</strong> for every leg this driver delivered this week
                      {' '}+ payroll <strong>adjustments</strong> (bonuses, deductions, deferred amounts)
                      {' '}+ pay-to-driver <strong>accessorials</strong> matched to this driver by name.
                    </>
                  )
                }>
                <Info size={11} style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div className="text-[18px] font-semibold" style={{ color: isFinalized ? '#1e8e3e' : 'var(--gc-text-1)' }}>{fmtMoney(displayTotal)}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5 inline-flex items-center gap-1" style={{ color: 'var(--gc-text-3)' }}>
              Load Revenue
              <Tooltip
                placement="bottom"
                content={
                  <>
                    Sum of <strong>per-leg revenue</strong> across this driver&rsquo;s loads this week. Non-relay legs use full loadPrice; relay legs are prorated by loaded miles (each leg gets its mileage share of the load&rsquo;s total).
                  </>
                }>
                <Info size={11} style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help' }} />
              </Tooltip>
            </div>
            <div className="text-[18px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(totalRev)}</div>
          </div>
          <button
            onClick={handleDriverPrint}
            disabled={printing}
            title="Download pay stub PDF"
            className="flex items-center justify-center rounded-full transition-colors"
            style={{ width: 34, height: 34, border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-2)', flexShrink: 0 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-bg)'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
          >
            {printing
              ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
              : <Download size={14} />}
          </button>
        </div>
      </div>

      {/* ── Drift banner ──────────────────────────────────────────────
          Shown when a finalized week's live values no longer match what
          was frozen. We never silently reconcile (that would rewrite a
          pay record) and we never block the edit that caused it — we
          say what changed and offer to re-snapshot. */}
      {isFinalized && drift?.differs && (
        <div
          className="px-5 py-3 text-xs print:hidden"
          style={{ background: '#f59e0b0e', borderTop: '1px solid var(--gc-border-light)', color: '#b45309' }}
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <div className="flex-1">
              <div className="font-semibold">
                Current values differ from what was finalized
              </div>
              <div className="mt-1" style={{ color: 'var(--gc-text-2)' }}>
                Finalized <strong>{fmtMoney(drift.snapshotTotal)}</strong>
                {' · '}current <strong>{fmtMoney(drift.liveTotal)}</strong>
                {' · '}
                <strong style={{ color: drift.delta >= 0 ? '#1e8e3e' : '#d93025' }}>
                  {drift.delta >= 0 ? '+' : ''}{fmtMoney(drift.delta)}
                </strong>
                {drift.hasDetail && (drift.added.length > 0 || drift.removed.length > 0 || drift.changed.length > 0) && (
                  <>
                    {' — '}
                    {[
                      drift.changed.length > 0 ? `${drift.changed.length} line${drift.changed.length !== 1 ? 's' : ''} changed` : null,
                      drift.added.length   > 0 ? `${drift.added.length} added`   : null,
                      drift.removed.length > 0 ? `${drift.removed.length} no longer in this week` : null,
                    ].filter(Boolean).join(', ')}
                  </>
                )}
                {!drift.hasDetail && (
                  <> — this record predates line-item snapshots, so only the totals can be compared.</>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={snapshotWeek}
                  disabled={finalizing}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: '#1e8e3e', color: '#fff', opacity: finalizing ? 0.7 : 1, cursor: 'pointer' }}
                  title="Record today’s numbers as the new finalized amount. The previous record is kept, not overwritten."
                >
                  {finalizing ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                  Re-finalize at {fmtMoney(drift.liveTotal)}
                </button>
                <button
                  onClick={() => setShowLive(v => !v)}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {showLive ? <History size={12} /> : <Eye size={12} />}
                  {showLive ? 'Back to finalized stub' : 'View current values'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Frozen-view notice — no drift, just a reminder that these rows
          are the issued record rather than a live computation. */}
      {frozenView && !drift?.differs && (
        <div
          className="flex items-center gap-2 px-5 py-2 text-xs print:hidden"
          style={{ background: '#1e8e3e08', borderTop: '1px solid var(--gc-border-light)', color: 'var(--gc-text-3)' }}
        >
          <Lock size={12} />
          Showing the finalized record as issued.
          <button
            onClick={() => setShowLive(true)}
            className="font-semibold"
            style={{ color: 'var(--gc-blue)', background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            View current values
          </button>
        </div>
      )}
      {isFinalized && showLive && (
        <div
          className="flex items-center gap-2 px-5 py-2 text-xs print:hidden"
          style={{ background: 'var(--gc-hover)', borderTop: '1px solid var(--gc-border-light)', color: 'var(--gc-text-3)' }}
        >
          <Eye size={12} />
          Showing current values — editable. The finalized record is unchanged.
          {snapshot && (
            <button
              onClick={() => setShowLive(false)}
              className="font-semibold"
              style={{ color: 'var(--gc-blue)', background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              Back to finalized stub
            </button>
          )}
        </div>
      )}

      {/* Auto-suggest banner for spanning relay loads — an action prompt,
          so it only belongs on the live, editable view. */}
      {!frozenView && spanningRelayLoadIds.size > 0 && (
        <div
          className="flex items-center gap-2 px-5 py-2.5 text-xs font-medium print:hidden"
          style={{ background: '#f59e0b0e', borderTop: '1px solid var(--gc-border-light)', color: '#d97706' }}
        >
          <AlertCircle size={13} />
          {spanningRelayLoadIds.size === 1
            ? `1 load’s delivery falls in the following week`
            : `${spanningRelayLoadIds.size} loads’ deliveries fall in the following week`}
          {' '}— click <CornerDownRight size={11} style={{ display: 'inline', verticalAlign: 'middle', margin: '0 2px' }} /> on the row to defer pay.
        </div>
      )}

      {/* Finalized week → the frozen stub. Not a recompute. */}
      {frozenView && (
        <FrozenStubTable
          groups={snapshotGroups!}
          liveLoadIds={liveLoadIdSet}
          onOpenLoad={openEditModal}
        />
      )}

      {/* Loads table (live view) */}
      {!frozenView && (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              {['Date', 'Leg', 'Event Title', 'Load #', 'Miles', 'Load Value', 'Driver Pay'].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>{h}</th>
              ))}
              <th className="px-2 py-2.5 print:hidden" style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {row.loads.map(load => {
              const pickupDate    = parseDate(load.start);
              const isSpanning    = spanningRelayLoadIds.has(load.id);
              const isDeferOpen   = deferLoadId === load.id;
              const isDeferredIn  = load.deferredToWeek === weekStart; // came from another week
              const isUndoOpen    = undoDeferLoadId === load.id;
              return (
                <Fragment key={load.id}>
                  <tr
                    style={{
                      borderBottom: isDeferOpen ? 'none' : '1px solid var(--gc-border-light)',
                      background: isSpanning && !isDeferOpen ? '#f59e0b0a' : undefined,
                    }}
                    onMouseOver={e => { if (!isDeferOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseOut={e => { e.currentTarget.style.background = isSpanning && !isDeferOpen ? '#f59e0b0a' : 'transparent'; }}
                  >
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
                      <div className="flex items-center gap-1.5">
                        {pickupDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        {isSpanning && !isDeferOpen && (
                          <span
                            title="Delivery is in the following week — consider deferring pay"
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] font-bold shrink-0"
                            style={{ background: '#f59e0b28', color: '#d97706' }}
                          >!</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3"><LegBadge role={load.relayRole} /></td>
                    <td className="px-4 py-3 max-w-[240px]">
                      {/* TONU + cancelled get a colored pill before the
                          title so it's obvious at a glance that this
                          isn't a normal load — payroll legitimately pays
                          for TONUs and sometimes for cancelled-mid-route
                          loads, but the user needs to spot them when
                          reviewing the week. Status read from load.status
                          mirrors CalendarEvent.tsx's prefix logic. */}
                      <button onClick={() => openEditModal(load.id)}
                        className="inline-flex items-center gap-1.5 max-w-full text-left font-medium hover:underline"
                        style={{ color: 'var(--gc-blue)' }} title={load.title}>
                        {load.status === 'tonu' && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide shrink-0"
                            style={{ background: '#fde68a', color: '#854d0e' }}>
                            TONU
                          </span>
                        )}
                        {load.status === 'cancelled' && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide shrink-0"
                            style={{ background: '#fee2e2', color: '#b91c1c' }}>
                            Cancelled
                          </span>
                        )}
                        <span className="truncate min-w-0">
                          {load.title ?? '(no title)'}
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {load.loadNum
                        ? <CopyChip value={load.loadNum} style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-2)' }} />
                        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums" style={{ color: load.loadedMiles != null && load.eventKind !== 'non_revenue' ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
                      {/* Maintenance / non-revenue events don't have a
                          "loaded miles" concept — they're not loads.
                          A stale value on the column (left over from
                          when the event briefly had coordinates) shouldn't
                          render here. Display em-dash for any non-revenue
                          event regardless of what the column says. */}
                      {load.loadedMiles != null && load.eventKind !== 'non_revenue'
                        ? `${Math.round(load.loadedMiles).toLocaleString()} mi`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 font-semibold whitespace-nowrap" style={{ color: 'var(--gc-text-1)' }}>
                      {(() => {
                        const rev = legRevenue(load);
                        if (load.loadPrice == null) return '—';
                        // Tag prorated relay legs so the dispatcher
                        // sees this is a SHARE of the full rate, not
                        // the whole thing.
                        if (load.relayGroupId) {
                          return (
                            <span
                              title={`Pro-rated share of $${(load.loadPrice ?? 0).toLocaleString()} total load value`}
                              style={{ borderBottom: '1px dotted var(--gc-text-3)' }}>
                              {fmtMoney(rev)}
                            </span>
                          );
                        }
                        return fmtMoney(rev);
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      {/* The old bare "27%" chip lived here with no
                          statement of what it was 27% OF. PayCell now
                          renders both denominators, each labelled. */}
                      <PayCell
                        load={load}
                        legRevenue={legRevenue(load)}
                        legCount={load.relayGroupId
                          ? allEvents.filter(e => e.relayGroupId === load.relayGroupId).length
                          : 1}
                        locked={isFinalized}
                      />
                    </td>
                    {/* Defer / Undo icon */}
                    <td className="px-2 py-3 print:hidden">
                      {isDeferredIn ? (
                        /* Deferred-in load: show undo button */
                        <Tooltip content={<>Undo defer — move this load&rsquo;s pay back to its <strong>original week</strong>. Removes the matched +/&minus; deferred adjustment pair.</>}>
                          <button
                            onClick={() => setUndoDeferLoadId(isUndoOpen ? null : load.id)}
                            className="flex items-center justify-center w-7 h-7 rounded-full transition-colors"
                            style={{ color: '#6941c6', background: isUndoOpen ? '#6941c61a' : 'transparent' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#6941c61a'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = isUndoOpen ? '#6941c61a' : 'transparent'; }}
                          >
                            <RotateCcw size={13} />
                          </button>
                        </Tooltip>
                      ) : (
                        /* Normal load: show defer button */
                        <Tooltip
                          content={
                            isDeferOpen
                              ? <>Cancel</>
                              : isSpanning
                                ? <><strong>Delivery falls in next week.</strong> Defer this load&rsquo;s pay so the driver gets paid the week the freight actually delivers, not the week it picked up.</>
                                : <>Defer this load&rsquo;s driver pay to a <strong>future week</strong>. Writes a matched pair of adjustments and removes the load&rsquo;s pay contribution here.</>
                          }>
                          <button
                            onClick={() => { if (isDeferOpen) { setDeferLoadId(null); setDeferConfirm(false); } else { openDeferForLoad(load); } }}
                            className="flex items-center justify-center w-7 h-7 rounded-full transition-colors"
                            style={{
                              color: isSpanning ? '#d97706' : isDeferOpen ? 'var(--gc-blue)' : 'var(--gc-text-3)',
                              background: isDeferOpen ? 'var(--gc-hover)' : 'transparent',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = isDeferOpen ? 'var(--gc-hover)' : 'transparent'; }}
                          >
                            <CornerDownRight size={13} />
                          </button>
                        </Tooltip>
                      )}
                    </td>
                  </tr>

                  {/* Undo defer confirm */}
                  {isUndoOpen && (
                    <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                      <td colSpan={8} style={{ padding: '10px 16px 12px', background: 'var(--gc-surface)' }}>
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-sm flex-1" style={{ color: 'var(--gc-text-2)' }}>
                            Move <strong>{load.title ?? 'this load'}</strong> back to its original week?
                          </span>
                          <button
                            onClick={() => handleUndoDeferLoad(load)}
                            disabled={deferring}
                            className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
                            style={{ background: '#6941c6', color: '#fff', height: 34, opacity: deferring ? 0.7 : 1, cursor: 'pointer' }}
                          >
                            {deferring ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Undo Defer
                          </button>
                          <button
                            onClick={() => setUndoDeferLoadId(null)}
                            className="text-sm px-3 rounded-lg transition-colors"
                            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', height: 34, cursor: 'pointer' }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {/* Inline defer form */}
                  {isDeferOpen && (
                    <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                      <td colSpan={8} style={{ padding: '10px 16px 12px', background: 'var(--gc-surface)' }}>
                        {!deferConfirm ? (
                          /* ── Form: just pick the target week ── */
                          <div className="flex items-end gap-3 flex-wrap">
                            {isSpanning && (
                              <div className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg w-full mb-1"
                                style={{ background: '#f59e0b12', color: '#d97706', border: '1px solid #f59e0b2a' }}>
                                <AlertCircle size={12} />
                                Delivery falls in the following week — defer the load to match.
                              </div>
                            )}
                            <div className="flex flex-col gap-1" style={{ minWidth: 180, flex: 1 }}>
                              <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
                                Defer Load to Week
                              </label>
                              <select
                                value={deferToWeekIdx}
                                onChange={e => setDeferToWeekIdx(+e.target.value)}
                                style={{ ...INPUT_STYLE, width: '100%' }}
                                autoFocus
                              >
                                {deferWeeks.map((w, i) => (
                                  <option key={i} value={i}>{fmtDate(w.sat)} – {fmtDate(w.fri)}</option>
                                ))}
                              </select>
                            </div>
                            <button
                              onClick={() => setDeferConfirm(true)}
                              className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
                              style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, cursor: 'pointer' }}
                            >
                              <CornerDownRight size={13} /> Defer
                            </button>
                            <button
                              onClick={() => { setDeferLoadId(null); setDeferConfirm(false); }}
                              style={{ height: 34, width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                              <X size={15} />
                            </button>
                          </div>
                        ) : (
                          /* ── Confirm ── */
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-sm flex-1" style={{ color: 'var(--gc-text-2)' }}>
                              Defer <strong>{load.title ?? 'this load'}</strong> to week of{' '}
                              <strong>{fmtDate(deferWeeks[deferToWeekIdx].sat)}</strong>?
                            </span>
                            <button
                              onClick={() => handleDeferLoad(load)}
                              disabled={deferring}
                              className="flex items-center gap-1.5 text-sm font-semibold px-3 rounded-lg"
                              style={{ background: 'var(--gc-blue)', color: '#fff', height: 34, opacity: deferring ? 0.7 : 1, cursor: 'pointer' }}
                            >
                              {deferring ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Confirm
                            </button>
                            <button
                              onClick={() => setDeferConfirm(false)}
                              className="text-sm px-3 rounded-lg transition-colors"
                              style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', height: 34, cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                              Back
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {/* Accessorial adjustments (payToDriver items from load events) */}
      {!frozenView && payToDriverAccs.length > 0 && (
        <div style={{ borderTop: '1px solid var(--gc-border-light)', padding: '12px 20px 14px' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Accessorials
          </div>
          <div className="space-y-1.5">
            {payToDriverAccs.map(adj => (
              <div key={adj.id} className="flex items-center gap-3 text-sm group">
                {trashConfirm === adj.id ? (
                  <>
                    <span className="text-xs font-medium flex-1" style={{ color: 'var(--gc-text-2)' }}>
                      Remove this accessorial from payroll?
                    </span>
                    <button
                      onClick={() => removeAccAdj(adj.id)}
                      className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg"
                      style={{ background: '#d93025', color: '#fff' }}>
                      <Check size={11} /> Remove
                    </button>
                    <button
                      onClick={() => setTrashConfirm(null)}
                      className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                      style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="px-2 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                      style={{ background: '#1a73e81a', color: '#1a73e8' }}>
                      {adj.category}
                    </span>
                    <span className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                      {adj.description || <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                    </span>
                    <span className="font-semibold whitespace-nowrap" style={{ color: adj.amount >= 0 ? '#1e8e3e' : '#d93025' }}>
                      {adj.amount >= 0 ? '+' : ''}{fmtMoney(adj.amount)}
                    </span>
                    <button
                      onClick={() => setTrashConfirm(adj.id)}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded"
                      style={{ color: 'var(--gc-text-3)', flexShrink: 0 }}
                      title="Remove from payroll">
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kept MOUNTED in the frozen view, just hidden: it is the only
          source of the live adjustment list, and the drift banner above
          needs that list to tell you the stub and today's numbers have
          diverged. Switching to "current values" reveals it (and its
          Add / Defer controls) again. */}
      <div style={frozenView ? { display: 'none' } : undefined}>
        <AdjustmentsSection
          orgId={orgId} driverName={row.driverName} driverAliases={row.aliases}
          weekStart={weekStart}
          sat={sat}
          onListChange={setAdjList}
        />
      </div>

      {/* Finalize footer */}
      <div className="flex items-center justify-between px-5 py-3"
        style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
        <div className="text-sm flex flex-col gap-1" style={{ color: 'var(--gc-text-3)' }}>
          <div>
            {isFinalized
              ? `Recorded ${fmtMoney(record!.totalPay)} on ${new Date(record!.finalizedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                + (record!.finalizedByName ? ` by ${record!.finalizedByName}` : '')
                + (snapshot ? ` · ${snapshot.length} line${snapshot.length !== 1 ? 's' : ''} frozen` : ' · total only (no frozen detail)')
              : 'Review loads and adjustments before finalizing.'}
          </div>
          {isFinalized && record?.sentAt && (
            <div className="text-xs">
              Sent {new Date(record.sentAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              {record.sentVia && record.sentVia.length > 0 ? ` via ${record.sentVia.join(' + ')}` : ''}
              {record.viewedAt ? ` · Viewed ${new Date(record.viewedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
            </div>
          )}
          {sendFlash && (
            <div className="text-xs font-medium" style={{
              color: sendFlash.tone === 'ok'   ? '#137333'
                   : sendFlash.tone === 'warn' ? '#b45309'
                                                : '#c5221f',
            }}>
              {sendFlash.msg}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isFinalized ? (
            confirmReopen ? (
              <>
                <span className="text-sm font-medium" style={{ color: 'var(--gc-text-2)' }}>
                  Reopen {row.driverName}&rsquo;s {fmtMoney(record!.totalPay)} for this week?
                </span>
                <button onClick={handleReopen} disabled={reopening}
                  className="flex items-center gap-1.5 text-sm font-semibold px-4 py-1.5 rounded-lg"
                  style={{ background: '#b45309', color: '#fff', opacity: reopening ? 0.7 : 1, cursor: 'pointer' }}>
                  {reopening ? <Loader2 size={13} className="animate-spin" /> : <Unlock size={13} />}
                  Reopen
                </button>
                <button onClick={() => setConfirmReopen(false)}
                  className="text-sm px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {/* Send / Resend paystub. Only meaningful once finalized;
                    disabled while another action on this row is in flight. */}
                <Tooltip
                  content={
                    record?.sentAt
                      ? <>Resend the paystub link (SMS + push) to the driver. The link and numbers stay the same — this just texts the driver again.</>
                      : <>Text the driver a link to this paystub. Push notification also fires if they have the driver app installed. The numbers in the link are the frozen totals above.</>
                  }>
                  <button onClick={handleSend} disabled={sending || reopening}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                    style={{
                      color:       record?.sentAt ? 'var(--gc-text-3)' : '#fff',
                      background:  record?.sentAt ? 'transparent'      : '#1a73e8',
                      border:      record?.sentAt ? '1px solid var(--gc-border)' : '1px solid #1a73e8',
                      opacity:     sending ? 0.7 : 1,
                    }}
                    onMouseEnter={e => { if (!record?.sentAt) e.currentTarget.style.background = '#1558d6'; }}
                    onMouseLeave={e => { if (!record?.sentAt) e.currentTarget.style.background = '#1a73e8'; }}>
                    {sending
                      ? <Loader2 size={11} className="animate-spin" />
                      : <>{record?.sentAt ? 'Resend' : 'Send paystub'}</>}
                  </button>
                </Tooltip>
                <Tooltip
                  content={
                    <>
                      <strong>Reopen</strong> this driver&rsquo;s pay for the week so it can be finalized again at a new amount. The existing record is <strong>kept</strong> — superseded, not deleted — along with the amount, who finalized it, and who reopened it.
                    </>
                  }>
                  <button onClick={() => setConfirmReopen(true)}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                    style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <Unlock size={11} /> Reopen
                  </button>
                </Tooltip>
              </>
            )
          ) : confirmFin ? (
            <>
              <span className="text-sm font-medium" style={{ color: 'var(--gc-text-2)' }}>
                Record {fmtMoney(totalPay)} for {row.driverName}?
              </span>
              <button onClick={snapshotWeek} disabled={finalizing}
                className="flex items-center gap-1.5 text-sm font-semibold px-4 py-1.5 rounded-lg"
                style={{ background: '#1e8e3e', color: '#fff', opacity: finalizing ? 0.7 : 1 }}>
                {finalizing ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Confirm
              </button>
              <button onClick={() => setConfirmFin(false)}
                className="text-sm px-3 py-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                Cancel
              </button>
            </>
          ) : (
            <Tooltip
              placement="top"
              content={
                <>
                  <strong>Lock</strong> this driver&rsquo;s pay for the week. Records the total <em>and every line behind it</em> — the card and the printed stub then keep showing exactly these numbers even if loads or adjustments change later. If they do change, the card says so and offers to re-finalize. Use <em>Reopen</em> to unlock.
                </>
              }>
              <button onClick={() => setConfirmFin(true)}
                className="flex items-center gap-1.5 text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors"
                style={{ background: 'var(--gc-blue)', color: '#fff' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1558d6')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
                <Lock size={13} /> Finalize Pay
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Week selector dropdown ───────────────────────────────────────────────────

function WeekSelector({
  options,
  selectedIdx,
  onChange,
}: {
  options: ReturnType<typeof buildWeekOptions>;
  selectedIdx: number;
  onChange: (i: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium"
        style={{
          background: 'var(--gc-surface)',
          border: '1px solid var(--gc-border)',
          color: 'var(--gc-text-1)',
          boxShadow: 'var(--shadow-1)',
        }}
      >
        {options[selectedIdx].label}
        <ChevronDown size={14} style={{ color: 'var(--gc-text-3)' }} />
      </button>

      {open && (
        <div
          className="absolute right-0 mt-1 z-50 py-1 rounded-xl overflow-hidden"
          style={{
            background: 'var(--gc-surface)',
            border: '1px solid var(--gc-border)',
            boxShadow: 'var(--shadow-3)',
            minWidth: 260,
          }}
        >
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => { onChange(i); setOpen(false); }}
              className="w-full text-left px-4 py-2.5 text-[13px] flex items-center gap-2"
              style={{
                background: i === selectedIdx ? 'var(--gc-hover)' : 'transparent',
                color: 'var(--gc-text-1)',
              }}
              onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseOut={e => (e.currentTarget.style.background = i === selectedIdx ? 'var(--gc-hover)' : 'transparent')}
            >
              {i === selectedIdx && <Check size={13} style={{ color: 'var(--gc-blue)', flexShrink: 0 }} />}
              {i !== selectedIdx && <span style={{ width: 13 }} />}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PayrollView() {
  const {
    events,
    assets,
    drivers,
    loadedStart,
    loadedEnd,
    dbReady,
    extendLoadedRange,
    unassignedAssetId,
    orgId,
  } = useCalendarStore();

  const { organization } = useOrganization();

  const weekOptions = useMemo(() => buildWeekOptions(), []);
  const [weekIdx, setWeekIdx] = useState(FUTURE_WEEKS); // default to current week
  const [fetching, setFetching] = useState(false);
  // Driver names that have adjustments this week (even with no loads — e.g. deferred carry-ins)
  const [adjDriverNames, setAdjDriverNames] = useState<string[]>([]);
  // Full week-wide adjustments list, kept at page level so the header
  // strip can sum "Total Adjustments" and "Total Payroll" (loads +
  // adjustments). Previously each driver card fetched adjustments in
  // isolation and the totals up top only knew about load driverPay —
  // hence the header underreporting vs the dashboard's frozen-record
  // number by exactly the adjustments amount.
  const [weekAdjustments, setWeekAdjustments] = useState<PayrollAdjustment[]>([]);
  // Driver names with a FINALIZED record for this week. A finalized week
  // must keep its card even when the week no longer computes any loads
  // for that driver — e.g. the load was edited across the Saturday
  // boundary after payday. The stub exists, so it stays on screen.
  const [recordDriverNames, setRecordDriverNames] = useState<string[]>([]);

  const { sat, fri } = weekOptions[weekIdx];
  const weekStart = sat.toISOString().split('T')[0];

  // Extend loaded window if selected week isn't cached
  useEffect(() => {
    if (!dbReady) return;
    const startIso = sat.toISOString();
    const endIso   = fri.toISOString();
    if (loadedStart && loadedEnd && startIso >= loadedStart && endIso <= loadedEnd) return;
    setFetching(true);
    extendLoadedRange(startIso, endIso).finally(() => setFetching(false));
  }, [weekIdx, dbReady, sat, fri, loadedStart, loadedEnd, extendLoadedRange]);

  // Fetch adjustments for the selected week so drivers with only deferred pay still appear
  useEffect(() => {
    if (!orgId || !weekStart) return;
    fetchPayrollAdjustments(orgId, weekStart).then(adjs => {
      const names = [...new Set(adjs.map(a => a.driverName).filter(Boolean))];
      setAdjDriverNames(names);
      setWeekAdjustments(adjs);
    });
  }, [orgId, weekStart]); // eslint-disable-line

  // Finalized records for the week — see recordDriverNames above.
  useEffect(() => {
    if (!orgId || !weekStart) return;
    let cancelled = false;
    fetchPayrollRecordsForWeek(weekStart).then(recs => {
      if (cancelled) return;
      setRecordDriverNames([...new Set(recs.map(r => r.driverName).filter(Boolean))]);
    });
    return () => { cancelled = true; };
  }, [orgId, weekStart]);

  // Pull the canonical week load set from the same server endpoint the
  // Dashboard uses (/v1/reports/loads via listLoadSummaries). That's
  // our source of truth for "how much revenue did we book this week
  // and how many loads is it" — driven by the loads table directly,
  // with the same pickupAt window the rest of the reporting surfaces
  // already use. Using this instead of the events-store keeps Payroll
  // and Dashboard agreeing by construction; previously each side
  // computed its own filter over its own data source and they kept
  // disagreeing on boundary loads (Unassigned-asset rules, parseDate
  // timezone quirks, zombie events, etc.).
  //
  // Falls back to null while in-flight; the KPI tile shows the local
  // events-store estimate until the canonical value arrives.
  const [weekLoadSummaries, setWeekLoadSummaries] = useState<LoadSummary[] | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    (async () => {
      try {
        // /v1/reports/loads string-compares pickupFrom/To against
        // pickupAt, which is stored as a NAIVE org-local string
        // ("2026-05-30T01:00:00", no Z). For the lex compare to be
        // meaningful both sides must share TZ semantics — so we send
        // naive cutoffs here too. Sending pStart.toISOString() (Z-
        // suffixed UTC) was the wrong shape and caused dashboard ↔
        // payroll disagreement after the dashboard's TZ fix landed.
        const pad = (n: number) => String(n).padStart(2, '0');
        const fromKey = `${sat.getFullYear()}-${pad(sat.getMonth() + 1)}-${pad(sat.getDate())}`;
        const toKey   = `${fri.getFullYear()}-${pad(fri.getMonth() + 1)}-${pad(fri.getDate())}`;
        const { loads } = await railway.listLoadSummaries({
          pickupFrom: `${fromKey}T00:00:00.000`,
          pickupTo:   `${toKey}T23:59:59.999`,
        });
        if (!cancelled) setWeekLoadSummaries(loads);
      } catch (err) {
        console.error('[PayrollView] listLoadSummaries failed:', err);
        if (!cancelled) setWeekLoadSummaries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady, sat, fri]);

  // Filter events to the selected week.
  //
  // Asset filtering: a load sitting on the "Unassigned" truck
  // placeholder STILL counts toward payroll AS LONG AS a driver is
  // assigned — dispatchers will often pin the driver before they've
  // decided which truck runs the load, and that driver still earns
  // pay credit. Only a load with NEITHER a real truck NOR a driver
  // is genuinely floating; that's the one we drop.
  //
  // Deferred loads: excluded from their original week, included in
  // their target week.
  const weekEvents = useMemo(() => events.filter(e => {
    // Determine whether this event is sitting on the Unassigned
    // placeholder asset. Two paths: explicit unassignedAssetId
    // sentinel (set on hydrate) OR the asset row's name/type field
    // being literally "Unassigned" (legacy / imported orgs).
    const onUnassignedAsset =
      (unassignedAssetId !== null && e.assetId === unassignedAssetId) ||
      (() => {
        const a = assets.find(x => x.id === e.assetId);
        return a?.type === 'Unassigned' || a?.name === 'Unassigned';
      })();
    const hasDriver = !!e.driverId || !!(e.driverName && e.driverName.trim());
    if (onUnassignedAsset && !hasDriver) return false;
    // If deferred to a different week, hide from original week
    if (e.deferredToWeek && e.deferredToWeek !== weekStart) return false;
    const d = parseDate(e.start);
    // Show if start falls in this week, OR if explicitly deferred to this week
    return (d >= sat && d <= fri) || e.deferredToWeek === weekStart;
  }), [events, assets, sat, fri, weekStart, unassignedAssetId]);

  // Group by driver — IDENTITY-based, not name-based. Loads carrying
  // a driverId fold into one row keyed by that id, with the canonical
  // current name from the driver record shown as the label. This
  // prevents a renamed driver from spawning duplicate payroll rows
  // (one under the old name, one under the new) the way pure name-
  // based grouping did. Each row tracks every name alias we've seen
  // for that driver so historical adjustments saved under the old
  // name still flow into the right group.
  const driverGroups = useMemo((): DriverRow[] => {
    const NO_DRIVER = '(No Driver Assigned)';
    // Map key: "id:<id>" for id-anchored groups, "name:<lowercased>"
    // for legacy-only groups. Keeps the two namespaces separate so a
    // driverName that happens to match the canonical name of an
    // un-related id-anchored row doesn't accidentally merge.
    const groups = new Map<string, { row: DriverRow; aliasSet: Set<string> }>();

    const canonicalName = (d: typeof drivers[number]) =>
      `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || d.name || '';

    const addEvent = (key: string, row: Omit<DriverRow, 'loads'>, ev: CalendarEvent | null) => {
      const existing = groups.get(key);
      if (existing) {
        if (ev) existing.row.loads.push(ev);
        // Track any name variant that landed in this group.
        const nm = ev?.driverName?.trim();
        if (nm) existing.aliasSet.add(nm);
        return;
      }
      const aliasSet = new Set<string>(row.aliases);
      const nm = ev?.driverName?.trim();
      if (nm) aliasSet.add(nm);
      const newRow: DriverRow = {
        ...row,
        loads: ev ? [ev] : [],
        aliases: [...aliasSet],
      };
      groups.set(key, { row: newRow, aliasSet });
    };

    for (const e of weekEvents) {
      // Prefer id-based match: rename-resistant.
      const driverRec = e.driverId != null
        ? drivers.find(d => d.id === e.driverId)
        : undefined;
      if (driverRec) {
        const display = canonicalName(driverRec);
        const aliases = new Set<string>();
        if (display) aliases.add(display);
        if (driverRec.name) aliases.add(driverRec.name);
        addEvent(`id:${driverRec.id}`, {
          driverName: display || (e.driverName?.trim() ?? NO_DRIVER),
          aliases: [...aliases],
          driverId: driverRec.id,
        }, e);
        continue;
      }
      // No id (or no matching record) — fall back to the load's
      // stored driverName. Legacy rows with the same name still
      // collapse together here.
      const name = e.driverName?.trim() || '';
      if (!name) {
        addEvent(`name:${NO_DRIVER}`, { driverName: NO_DRIVER, aliases: [NO_DRIVER] }, e);
      } else {
        addEvent(`name:${name.toLowerCase()}`, { driverName: name, aliases: [name] }, e);
      }
    }

    // Pull in any driver records that have adjustments this week
    // but no loads — keeps deferred carry-ins from disappearing.
    // Match by any alias the record's canonical or legacy name
    // would generate.
    //
    // Drivers with a FINALIZED record go through the same path: a week
    // that was paid must keep its card even if every load has since been
    // edited out of it, or the stub would vanish with no trace.
    for (const adjName of [...new Set([...adjDriverNames, ...recordDriverNames])]) {
      if (!adjName) continue;
      const lower = adjName.toLowerCase();
      // Already represented by some group's alias set?
      let matched = false;
      for (const g of groups.values()) {
        if (g.aliasSet.has(adjName) ||
            [...g.aliasSet].some(a => a.toLowerCase() === lower)) {
          g.aliasSet.add(adjName);
          g.row.aliases = [...g.aliasSet];
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // Try to attach to a driver record by name (handles the case
      // where loads weren't run this week but the driver exists).
      const rec = drivers.find(d => {
        const can = canonicalName(d).toLowerCase();
        return can === lower || (d.name ?? '').toLowerCase() === lower;
      });
      if (rec) {
        const display = canonicalName(rec);
        addEvent(`id:${rec.id}`, {
          driverName: display || adjName,
          aliases: [display || adjName, rec.name ?? '', adjName].filter(Boolean) as string[],
          driverId: rec.id,
        }, null);
      } else {
        addEvent(`name:${lower}`, { driverName: adjName, aliases: [adjName] }, null);
      }
    }

    const rows: DriverRow[] = [...groups.values()].map(g => ({
      ...g.row,
      loads: [...g.row.loads].sort((a, b) => a.start.localeCompare(b.start)),
    }));

    rows.sort((a, b) => {
      const aNo = a.driverName === NO_DRIVER;
      const bNo = b.driverName === NO_DRIVER;
      if (aNo && !bNo) return 1;
      if (!aNo && bNo) return -1;
      return a.driverName.localeCompare(b.driverName);
    });
    return rows;
  }, [weekEvents, adjDriverNames, recordDriverNames, drivers]);

  // Total driver pay across every leg — each driver gets paid for
  // their leg, so summing every event's driverPay is the correct
  // "what left our books via loads" answer. NOT the whole payroll —
  // see totalPayroll below.
  const totalPay = driverGroups.reduce((s, g) => s + g.loads.reduce((ss, l) => ss + (l.driverPay ?? 0), 0), 0);
  // Adjustments (bonuses, deductions, per-diem, deferrals) are stored
  // in payroll_adjustments and can be negative. Summed here so the
  // strip up top can show them separately AND folded into a true
  // "Total Payroll" figure. Restricted to the same driver-name set
  // the driver cards actually render so an owner-op adjustment we
  // deliberately exclude from cards can't sneak into the total.
  const visibleDriverNameSet = new Set(driverGroups.map(g => g.driverName));
  const totalAdjustments = weekAdjustments.reduce(
    (s, a) => visibleDriverNameSet.has(a.driverName) ? s + (a.amount ?? 0) : s,
    0,
  );
  // What the dashboard's Total Payroll tile is trying to show —
  // driver pay from loads + every adjustment. This should match the
  // dashboard's frozen-record number for a fully finalized week
  // (unless a load was edited after finalization).
  const totalPayroll = totalPay + totalAdjustments;
  // Total LOADS and Total REVENUE — both come from the canonical
  // /v1/reports/loads server endpoint (weekLoadSummaries) so this
  // tile agrees with the Dashboard's Total Revenue card exactly. One
  // server, one filter, one sum.
  //
  // Revenue = rate-con price + billable accessorials. Same shape as
  // LoadsReport's "Total" column footer — accessorials that the
  // dispatcher flagged as billable to the broker are part of the
  // revenue we booked. Non-billable accessorials (lumper reimbursements,
  // driver per-diem) are excluded by design.
  //
  // While the request is in flight we fall back to the events-store
  // estimate so the tile doesn't render blank on the first paint —
  // same pattern Dashboard's KPI useMemo uses.
  const totalLoads = useMemo(() => {
    if (weekLoadSummaries) return weekLoadSummaries.length;
    const seen = new Set<string>();
    for (const ev of weekEvents) seen.add(ev.loadId ?? ev.id);
    return seen.size;
  }, [weekLoadSummaries, weekEvents]);
  const totalRevenue = useMemo(() => {
    if (weekLoadSummaries) {
      // Total billable (linehaul + billable accessorials), maintained
      // by the loads_compute_total_billable trigger. Falls back to
      // inline math for any legacy row.
      return weekLoadSummaries.reduce((s, l) => {
        if (l.totalBillable != null) return s + l.totalBillable;
        const accessorials = (l.accessorials ?? [])
          .reduce((acc, a) => acc + (a.billable ? (a.amount ?? 0) : 0), 0);
        return s + (l.loadPrice ?? 0) + accessorials;
      }, 0);
    }
    // Fallback: events-store, dedupe by loadId, take max loadPrice.
    // Skip accessorials in fallback — events store doesn't carry the
    // billable flag uniformly; the tile only flashes this value for
    // a fraction of a second before snapping to the canonical
    // weekLoadSummaries number above.
    const byLoad = new Map<string, number>();
    for (const ev of weekEvents) {
      const key = ev.loadId ?? ev.id;
      const cur = byLoad.get(key) ?? 0;
      byLoad.set(key, Math.max(cur, ev.loadPrice ?? 0));
    }
    let total = 0;
    for (const v of byLoad.values()) total += v;
    return total;
  }, [weekLoadSummaries, weekEvents]);
  // Payroll as % of revenue — the headline labor-cost ratio. Null
  // when revenue is zero (we'd be dividing by 0) so the UI can render
  // an em-dash instead of "Infinity%".
  // Uses totalPayroll (loads + adjustments) so bonuses/deductions
  // move this ratio the same way they move the actual bank hit —
  // previously it read the load-only figure and understated the true
  // cost of the week.
  const payrollPctOfRevenue = totalRevenue > 0
    ? (totalPayroll / totalRevenue) * 100
    : null;

  const orgName    = organization?.name    ?? 'My Organization';
  const orgLogoUrl = organization?.imageUrl;
  const weekLabel  = weekOptions[weekIdx].label;

  return (
    <AppShell title="Payroll" icon={Users}>
      <DataLoader />

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-6 relative">
        {fetching && (
          <div className="absolute inset-0 z-10 flex items-start justify-end p-4 pointer-events-none">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', boxShadow: 'var(--shadow-1)', color: 'var(--gc-text-2)' }}
            >
              <Loader2 size={13} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
              Loading data…
            </div>
          </div>
        )}

        <div className="w-full space-y-5">

          {/* Title row */}
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[32px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.5px' }}>
                Payroll
              </h2>
              <p className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                {fmtDateFull(sat)} – {fmtDateFull(fri)}
              </p>
            </div>
            <WeekSelector options={weekOptions} selectedIdx={weekIdx} onChange={setWeekIdx} />
          </div>

          {/* Summary strip */}
          {driverGroups.length > 0 && (
            <div
              className="flex items-center gap-8 px-5 py-4 rounded-xl"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}
            >
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Total Driver Pay
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {fmtMoney(totalPay)}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Total Adjustments
                </div>
                {/* Negative net (net deductions > bonuses) tints red so
                    the sign isn't only carried by a small "-" in front
                    of the figure. Zero renders neutral, not colored. */}
                <div
                  className="text-[22px] font-semibold"
                  style={{
                    color:
                      totalAdjustments > 0  ? '#1e8e3e' :
                      totalAdjustments < 0  ? '#d93025' :
                                              'var(--gc-text-3)',
                  }}>
                  {totalAdjustments === 0
                    ? '—'
                    : `${totalAdjustments < 0 ? '−' : '+'}${fmtMoney(Math.abs(totalAdjustments))}`}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Total Payroll
                </div>
                {/* The number that should agree with the dashboard's
                    Total Payroll tile (driver pay + adjustments). */}
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {fmtMoney(totalPayroll)}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Total Revenue
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {fmtMoney(totalRevenue)}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Payroll % of Revenue
                </div>
                <div
                  className="text-[22px] font-semibold"
                  // Color tints the headline figure when the ratio
                  // crosses notable bands so the dispatcher gets an
                  // at-a-glance read: green under 30% (healthy), neutral
                  // 30–40%, amber 40–50%, red above 50% (loss-leader
                  // territory). Numbers are conservative — tighten the
                  // thresholds for your fleet if needed.
                  style={{
                    color:
                      payrollPctOfRevenue == null   ? 'var(--gc-text-3)' :
                      payrollPctOfRevenue < 30       ? '#1e8e3e' :
                      payrollPctOfRevenue < 40       ? 'var(--gc-text-1)' :
                      payrollPctOfRevenue < 50       ? '#b85c00' :
                                                       '#d93025',
                  }}
                >
                  {payrollPctOfRevenue == null
                    ? '—'
                    : `${payrollPctOfRevenue.toFixed(1)}%`}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Drivers
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {driverGroups.filter(g => g.driverName !== '(No Driver Assigned)').length}
                </div>
              </div>
              <div style={{ width: 1, height: 40, background: 'var(--gc-border)' }} />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Loads
                </div>
                <div className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {totalLoads}
                </div>
              </div>
            </div>
          )}

          {/* Driver cards */}
          {driverGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <AlertCircle size={44} style={{ color: 'var(--gc-border)', marginBottom: 16 }} />
              <p className="text-base font-medium" style={{ color: 'var(--gc-text-2)' }}>
                No loads for this week
              </p>
              <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
                Try selecting a different week, or add loads in the calendar.
              </p>
              <Link
                href="/calendar"
                className="mt-5 px-5 py-2 rounded-lg text-sm font-medium"
                style={{ background: 'var(--gc-blue)', color: 'white' }}
              >
                Go to Calendar
              </Link>
            </div>
          ) : (
            driverGroups.map(row => (
              <DriverCard
                key={row.driverName}
                row={row}
                assets={assets}
                drivers={drivers}
                orgId={orgId ?? ''}
                weekStart={sat.toISOString().split('T')[0]}
                orgName={orgName}
                orgLogoUrl={orgLogoUrl}
                weekLabel={weekLabel}
                sat={sat}
                fri={fri}
              />
            ))
          )}

        </div>
      </div>
    </AppShell>
  );
}
